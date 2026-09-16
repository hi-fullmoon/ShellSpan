//! Versioned fixed-purpose remote deployment runner.
//!
//! The UI supplies only frozen identities. This module re-resolves every
//! runtime-owned reference, installs the compiled-in runner by SHA-256, writes
//! a strict data-only request, launches it detached, and reconciles its atomic
//! status/event files into the local immutable run ledger.

use super::artifact::{
    inspect_deployment_artifact_source_with_handle, verify_deployment_artifact,
    VerifiedDeploymentArtifact,
};
use super::planner::{get_deployment_plan, target_identity};
use super::preflight::connection_for_profile;
use super::repository::DeploymentEventWrite;
use super::{
    ApprovedDeploymentAction, DeploymentEventKind, DeploymentFrozenSourceRevision,
    DeploymentRunStatus, DeploymentTargetIdentitySnapshot,
};
use crate::db::Database;
use crate::execution::{
    execute_ssh_channel, open_ssh_execution_session, start_ssh_exec_channel, CancellationHandle,
    ExecutionCancellationRegistry, ExecutionErrorCategory, ExecutionOutputPolicy,
    ExecutionTerminalState, SshChannelExecutionOutcome,
};
use crate::keychain::CredentialManager;
use crate::models::RemoteConnectionRequest;
use libssh2_sys::LIBSSH2_FX_NO_SUCH_FILE;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ssh2::{ErrorCode, FileStat, FileType, OpenFlags, OpenType, RenameFlags, Sftp};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub(crate) const REMOTE_RUNNER_PROGRESS_EVENT: &str = "deployment-remote-runner-progress";
const OPERATION_PREFIX: &str = "deployment-remote-runner:";
const RECONCILIATION_OPERATION_PREFIX: &str = "deployment-reconciliation:";
const STAGING_PREFIX: &str = "deployment-staging-v1";
const RUNNER_VERSION: &str = "shellspan-deployment-runner-v1";
const REQUEST_SCHEMA_VERSION: u32 = 1;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 2 * 60 * 60 * 1_000;
const MAX_REMOTE_FILE_BYTES: usize = 128 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const MAX_CONSECUTIVE_POLL_FAILURES: usize = 3;
const RECONCILIATION_TIMEOUT: Duration = Duration::from_secs(30 * 60);

// This POSIX runner is part of the application binary. The native runtime
// installs it under a SHA-256-addressed name and the detached launcher verifies
// that digest before every start. It accepts exactly one strict request file;
// no workflow command, script, environment map, or path argument is accepted.
const REMOTE_RUNNER_SCRIPT: &str = r#"#!/bin/sh
set -u

request_file=${1-}
run_dir=${2-}
[ "$#" -eq 2 ] || exit 64
[ -f "$request_file" ] || exit 65
[ -d "$run_dir" ] || exit 65
umask 077

tab=$(printf '\t')
line_number=0
VALUE=
sequence=0
current_step=revalidate
side_effects_started=0
active_release_id=
rollback_observed_id=
failure_category=
summary=Validating_remote_runner_request

hash_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    return 1
  fi
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 1
  fi
}

read_expected() {
  line_number=$((line_number + 1))
  line=$(sed -n "${line_number}p" "$request_file") || return 1
  [ -n "$line" ] || return 1
  key=${line%%"$tab"*}
  [ "$line" != "$key" ] || return 1
  VALUE=${line#*"$tab"}
  [ "$key" = "$1" ] || return 1
  case "$VALUE" in *"$tab"*) return 1 ;; esac
  return 0
}

read_at() {
  at_line=$1
  expected_key=$2
  line=$(sed -n "${at_line}p" "$request_file") || return 1
  key=${line%%"$tab"*}
  [ "$line" != "$key" ] || return 1
  VALUE=${line#*"$tab"}
  [ "$key" = "$expected_key" ] || return 1
  case "$VALUE" in *"$tab"*) return 1 ;; esac
  return 0
}

valid_sha() {
  [ "${#1}" -eq 64 ] || return 1
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
}

valid_id() {
  [ -n "$1" ] && [ "${#1}" -le 128 ] || return 1
  case "$1" in *[!A-Za-z0-9._:-]*) return 1 ;; esac
}

valid_relative() {
  [ -n "$1" ] && [ "${#1}" -le 1024 ] || return 1
  case "$1" in
    /*|*\\*|.|..|../*|*/../*|*/..|*//*|*/./*|./*) return 1 ;;
    *[!A-Za-z0-9._/+@=-]*) return 1 ;;
  esac
}

write_status() {
  state=$1
  tmp="$run_dir/.status.$$.tmp"
  {
    printf 'schemaVersion=1\n'
    printf 'state=%s\n' "$state"
    printf 'step=%s\n' "$current_step"
    printf 'sideEffectsStarted=%s\n' "$side_effects_started"
    printf 'activeReleaseId=%s\n' "$active_release_id"
    printf 'rollbackReleaseId=%s\n' "$rollback_observed_id"
    printf 'failureCategory=%s\n' "$failure_category"
    printf 'sequence=%s\n' "$sequence"
    printf 'summary=%s\n' "$summary"
  } > "$tmp" || exit 74
  mv -f "$tmp" "$run_dir/status.v1" || exit 74
}

write_event() {
  phase=$1
  action=$2
  outcome=$3
  event_summary=$4
  sequence=$((sequence + 1))
  event_name=$(printf '%06d.event' "$sequence")
  event_tmp="$run_dir/events/.${event_name}.$$.tmp"
  event_final="$run_dir/events/$event_name"
  [ ! -e "$event_final" ] || {
    failure_category=stateUnknown
    summary=Remote_event_identity_conflict
    write_status state_unknown
    exit 75
  }
  {
    printf 'schemaVersion=1\n'
    printf 'sequence=%s\n' "$sequence"
    printf 'phase=%s\n' "$phase"
    printf 'action=%s\n' "$action"
    printf 'outcome=%s\n' "$outcome"
    printf 'summary=%s\n' "$event_summary"
  } > "$event_tmp" || exit 74
  mv "$event_tmp" "$event_final" || exit 74
}

intent() {
  current_step=$1
  summary=$2
  write_event intent "$current_step" pending "$summary"
  write_status in_progress
}

outcome() {
  current_step=$1
  event_outcome=$2
  summary=$3
  write_event outcome "$current_step" "$event_outcome" "$summary"
  write_status in_progress
}

finish_state() {
  final_state=$1
  current_step=recordResult
  summary=$2
  failure_category=$3
  write_status "$final_state"
  exit 0
}

request_invalid() {
  failure_category=stateUnknown
  summary=Remote_request_failed_closed_validation
  write_status state_unknown
  exit 65
}

read_expected request_digest || request_invalid
request_digest=$VALUE
valid_sha "$request_digest" || request_invalid
observed_request_digest=$(tail -n +2 "$request_file" | hash_stream) || request_invalid
[ "$observed_request_digest" = "$request_digest" ] || request_invalid

read_expected schema_version || request_invalid
[ "$VALUE" = 1 ] || request_invalid
read_expected runner_version || request_invalid
[ "$VALUE" = shellspan-deployment-runner-v1 ] || request_invalid
read_expected runner_sha256 || request_invalid
runner_sha256=$VALUE
valid_sha "$runner_sha256" || request_invalid
observed_runner_sha=$(hash_file "$0") || request_invalid
[ "$observed_runner_sha" = "$runner_sha256" ] || request_invalid
read_expected operation_id || request_invalid
operation_id=$VALUE
valid_id "$operation_id" || request_invalid
read_expected plan_id || request_invalid
plan_id=$VALUE
case "$plan_id" in plan-*) ;; *) request_invalid ;; esac
read_expected plan_digest || request_invalid
plan_digest=$VALUE
valid_sha "$plan_digest" || request_invalid
[ "$plan_id" = "plan-$plan_digest" ] || request_invalid
read_expected run_id || request_invalid
approved_run_id=$VALUE
valid_id "$approved_run_id" || request_invalid
[ "${run_dir##*/}" = "$approved_run_id" ] || request_invalid
read_expected expires_at_seconds || request_invalid
expires_at_seconds=$VALUE
case "$expires_at_seconds" in ''|*[!0-9]*) request_invalid ;; esac
now_seconds=$(date +%s) || request_invalid
[ "$now_seconds" -lt "$expires_at_seconds" ] || {
  failure_category=planExpired
  summary=Approved_plan_expired_before_remote_start
  write_status failed
  exit 0
}
read_expected remote_root || request_invalid
remote_root=$VALUE
case "$remote_root" in /*) ;; *) request_invalid ;; esac
[ "$remote_root" != / ] || request_invalid
[ "$run_dir" = "$remote_root/.shellspan/runs/$approved_run_id" ] || request_invalid
read_expected content_identity || request_invalid
content_identity=$VALUE
valid_sha "$content_identity" || request_invalid
read_expected manifest_digest || request_invalid
manifest_digest=$VALUE
valid_sha "$manifest_digest" || request_invalid
read_expected manifest_file_sha256 || request_invalid
manifest_file_sha256=$VALUE
valid_sha "$manifest_file_sha256" || request_invalid
read_expected release_id || request_invalid
release_id=$VALUE
valid_id "$release_id" || request_invalid
read_expected release_digest || request_invalid
release_digest=$VALUE
valid_sha "$release_digest" || request_invalid
read_expected archive_file || request_invalid
archive_file=$VALUE
case "$archive_file" in image.tar|image.tar.gz|image.tar.zst) ;; *) request_invalid ;; esac
read_expected archive_compression || request_invalid
archive_compression=$VALUE
case "$archive_compression" in none|gzip|zstd) ;; *) request_invalid ;; esac
read_expected archive_sha256 || request_invalid
archive_sha256=$VALUE
valid_sha "$archive_sha256" || request_invalid
[ "$archive_sha256" = "$release_digest" ] || request_invalid
read_expected image_repository || request_invalid
image_repository=$VALUE
case "$image_repository" in ''|*[!A-Za-z0-9._:/-]*) request_invalid ;; esac
read_expected image_tag || request_invalid
image_tag=$VALUE
[ "$image_tag" = "$release_id" ] || request_invalid
read_expected image_id || request_invalid
image_id=$VALUE
case "$image_id" in sha256:*) valid_sha "${image_id#sha256:}" || request_invalid ;; *) request_invalid ;; esac
read_expected compose_project || request_invalid
compose_project=$VALUE
valid_id "$compose_project" || request_invalid
read_expected pull_before_up || request_invalid
pull_before_up=$VALUE
case "$pull_before_up" in 0|1) ;; *) request_invalid ;; esac
read_expected health_enabled || request_invalid
health_enabled=$VALUE
case "$health_enabled" in 0|1) ;; *) request_invalid ;; esac
read_expected health_path || request_invalid
health_path=$VALUE
read_expected health_status || request_invalid
health_status=$VALUE
read_expected health_timeout || request_invalid
health_timeout=$VALUE
if [ "$health_enabled" = 1 ]; then
  case "$health_path" in /*) ;; *) request_invalid ;; esac
  case "$health_path" in //*) request_invalid ;; esac
  case "$health_status" in ''|*[!0-9]*) request_invalid ;; esac
  case "$health_timeout" in ''|*[!0-9]*) request_invalid ;; esac
  [ "$health_status" -ge 100 ] && [ "$health_status" -le 599 ] || request_invalid
  [ "$health_timeout" -ge 1 ] && [ "$health_timeout" -le 300 ] || request_invalid
else
  [ -z "$health_path" ] && [ "$health_status" = 0 ] && [ "$health_timeout" = 0 ] || request_invalid
fi
read_expected nginx_reload || request_invalid
nginx_reload=$VALUE
case "$nginx_reload" in 0|1) ;; *) request_invalid ;; esac
[ "$nginx_reload" = 0 ] || [ "$health_enabled" = 1 ] || request_invalid
read_expected rollback_release_id || request_invalid
rollback_release_id=$VALUE
[ -z "$rollback_release_id" ] || valid_id "$rollback_release_id" || request_invalid
read_expected rollback_release_digest || request_invalid
rollback_release_digest=$VALUE
if [ -n "$rollback_release_id" ]; then
  valid_sha "$rollback_release_digest" || request_invalid
else
  [ -z "$rollback_release_digest" ] || request_invalid
fi
read_expected compose_count || request_invalid
compose_count=$VALUE
case "$compose_count" in ''|*[!0-9]*) request_invalid ;; esac
[ "$compose_count" -ge 1 ] && [ "$compose_count" -le 8 ] || request_invalid
compose_start=$((line_number + 1))
i=0
while [ "$i" -lt "$compose_count" ]; do
  read_expected "compose_${i}_path" || request_invalid
  valid_relative "$VALUE" || request_invalid
  compose_path=$VALUE
  read_expected "compose_${i}_file" || request_invalid
  [ "$VALUE" = "compose/$compose_path" ] || request_invalid
  read_expected "compose_${i}_sha256" || request_invalid
  valid_sha "$VALUE" || request_invalid
  i=$((i + 1))
done
read_expected service_count || request_invalid
service_count=$VALUE
case "$service_count" in ''|*[!0-9]*) request_invalid ;; esac
[ "$service_count" -le 64 ] || request_invalid
service_start=$((line_number + 1))
i=0
while [ "$i" -lt "$service_count" ]; do
  read_expected "service_${i}" || request_invalid
  valid_id "$VALUE" || request_invalid
  i=$((i + 1))
done
read_expected end || request_invalid
[ "$VALUE" = 1 ] || request_invalid
extra=$(sed -n "$((line_number + 1))p" "$request_file") || request_invalid
[ -z "$extra" ] || request_invalid

staging="$remote_root/.shellspan/staging/$content_identity"
release_root="$remote_root/releases"
release_dir="$release_root/$release_id"
archive="$staging/$archive_file"
manifest="$staging/manifest.json"

summary=Remote_request_verified
write_status in_progress
intent lock Acquiring_workflow_deployment_lock
exec 9> "$remote_root/.shellspan/deployment.lock" || {
  outcome lock failed Deployment_lock_file_unavailable
  finish_state failed Deployment_lock_file_unavailable lockConflict
}
flock -n 9 || {
  outcome lock failed Deployment_lock_is_held
  finish_state failed Deployment_lock_is_held lockConflict
}
outcome lock succeeded Deployment_lock_acquired

current_step=revalidate
summary=Revalidating_remote_staging_identity
write_status in_progress
[ -d "$staging" ] && [ ! -L "$staging" ] || finish_state failed Remote_staging_directory_invalid stagingInvalid
[ -f "$archive" ] && [ ! -L "$archive" ] || finish_state failed Remote_archive_invalid stagingInvalid
[ -f "$manifest" ] && [ ! -L "$manifest" ] || finish_state failed Remote_manifest_invalid stagingInvalid
[ "$(hash_file "$archive")" = "$archive_sha256" ] || finish_state failed Remote_archive_digest_mismatch stagingInvalid
[ "$(hash_file "$manifest")" = "$manifest_file_sha256" ] || finish_state failed Remote_manifest_digest_mismatch stagingInvalid
i=0
while [ "$i" -lt "$compose_count" ]; do
  base=$((compose_start + i * 3))
  read_at "$base" "compose_${i}_path" || request_invalid
  compose_path=$VALUE
  read_at "$((base + 1))" "compose_${i}_file" || request_invalid
  compose_file=$VALUE
  read_at "$((base + 2))" "compose_${i}_sha256" || request_invalid
  compose_sha=$VALUE
  [ -f "$staging/$compose_file" ] && [ ! -L "$staging/$compose_file" ] || finish_state failed Remote_compose_file_invalid stagingInvalid
  [ "$(hash_file "$staging/$compose_file")" = "$compose_sha" ] || finish_state failed Remote_compose_digest_mismatch stagingInvalid
  i=$((i + 1))
done

cancel_requested() {
  [ -f "$run_dir/cancel.requested" ]
}

compose_exec() {
  action=$1
  selected_release=$2
  set -- docker compose --project-name "$compose_project"
  j=0
  while [ "$j" -lt "$compose_count" ]; do
    base=$((compose_start + j * 3))
    read_at "$base" "compose_${j}_path" || return 64
    set -- "$@" -f "$selected_release/compose/$VALUE"
    j=$((j + 1))
  done
  set -- "$@" -f "$selected_release/.shellspan.override.yaml"
  case "$action" in
    config)
      "$@" config >/dev/null 2>&1
      ;;
    pull)
      set -- "$@" pull
      j=0
      while [ "$j" -lt "$service_count" ]; do
        read_at "$((service_start + j))" "service_${j}" || return 64
        set -- "$@" "$VALUE"
        j=$((j + 1))
      done
      "$@" >/dev/null 2>&1
      ;;
    up)
      set -- "$@" up -d --no-build --pull never
      j=0
      while [ "$j" -lt "$service_count" ]; do
        read_at "$((service_start + j))" "service_${j}" || return 64
        set -- "$@" "$VALUE"
        j=$((j + 1))
      done
      "$@" >/dev/null 2>&1
      ;;
    services)
      "$@" config --services
      ;;
    running)
      "$@" ps --status running --services
      ;;
    *) return 64 ;;
  esac
}

write_override() {
  selected_release=$1
  service_file="$selected_release/.shellspan.services"
  : > "$service_file" || return 1
  if [ "$service_count" -eq 0 ]; then
    set -- docker compose --project-name "$compose_project"
    j=0
    while [ "$j" -lt "$compose_count" ]; do
      base=$((compose_start + j * 3))
      read_at "$base" "compose_${j}_path" || return 1
      set -- "$@" -f "$selected_release/compose/$VALUE"
      j=$((j + 1))
    done
    "$@" config --services > "$service_file" 2>/dev/null || return 1
  else
    j=0
    while [ "$j" -lt "$service_count" ]; do
      read_at "$((service_start + j))" "service_${j}" || return 1
      printf '%s\n' "$VALUE" >> "$service_file" || return 1
      j=$((j + 1))
    done
  fi
  [ -s "$service_file" ] || return 1
  override="$selected_release/.shellspan.override.yaml"
  override_tmp="$override.$$.tmp"
  printf 'services:\n' > "$override_tmp" || return 1
  while IFS= read -r service; do
    valid_id "$service" || return 1
    printf '  %s:\n    image: %s:%s\n' "$service" "$image_repository" "$image_tag" >> "$override_tmp" || return 1
  done < "$service_file"
  mv -f "$override_tmp" "$override" || return 1
}

health_check() {
  selected_release=$1
  deadline=$(( $(date +%s) + health_timeout ))
  [ "$health_enabled" = 1 ] || deadline=$(( $(date +%s) + 60 ))
  while [ "$(date +%s)" -le "$deadline" ]; do
    running_file="$run_dir/.running.$$.tmp"
    if compose_exec running "$selected_release" > "$running_file" 2>/dev/null; then
      all_running=1
      while IFS= read -r service; do
        grep -F -x "$service" "$running_file" >/dev/null 2>&1 || all_running=0
      done < "$selected_release/.shellspan.services"
      if [ "$all_running" = 1 ]; then
        if [ "$health_enabled" = 0 ]; then
          rm -f "$running_file"
          return 0
        fi
        observed_status=$(curl --silent --show-error --output /dev/null --max-time 5 --write-out '%{http_code}' "http://127.0.0.1$health_path" 2>/dev/null || true)
        if [ "$observed_status" = "$health_status" ]; then
          rm -f "$running_file"
          return 0
        fi
      fi
    fi
    rm -f "$running_file"
    cancel_requested && return 2
    sleep 1
  done
  return 1
}

activate_release() {
  selected_id=$1
  previous_id=$2
  if [ -n "$previous_id" ]; then
    ln -s "releases/$previous_id" "$remote_root/.previous.$approved_run_id" || return 1
    mv -Tf "$remote_root/.previous.$approved_run_id" "$remote_root/previous" || return 1
  fi
  ln -s "releases/$selected_id" "$remote_root/.current.$approved_run_id" || return 1
  mv -Tf "$remote_root/.current.$approved_run_id" "$remote_root/current" || return 1
}

restore_release() {
  original_category=$1
  [ -n "$rollback_release_id" ] || {
    failure_category=stateUnknown
    summary=No_frozen_rollback_release_is_available
    write_status state_unknown
    exit 0
  }
  rollback_dir="$release_root/$rollback_release_id"
  intent restoreRelease Restoring_frozen_rollback_release
  [ -d "$rollback_dir" ] && [ ! -L "$rollback_dir" ] || {
    outcome restoreRelease failed Rollback_release_directory_invalid
    finish_state state_unknown Rollback_release_directory_invalid rollbackFailed
  }
  [ -f "$rollback_dir/.shellspan-artifact-sha256" ] || {
    outcome restoreRelease failed Rollback_release_digest_missing
    finish_state state_unknown Rollback_release_digest_missing rollbackFailed
  }
  rollback_digest=$(sed -n '1p' "$rollback_dir/.shellspan-artifact-sha256")
  [ "$rollback_digest" = "$rollback_release_digest" ] || {
    outcome restoreRelease failed Rollback_release_digest_mismatch
    finish_state state_unknown Rollback_release_digest_mismatch rollbackFailed
  }
  [ -f "$rollback_dir/.shellspan.override.yaml" ] && [ -f "$rollback_dir/.shellspan.services" ] || {
    outcome restoreRelease failed Rollback_runtime_configuration_missing
    finish_state state_unknown Rollback_runtime_configuration_missing rollbackFailed
  }
  compose_exec up "$rollback_dir" || {
    outcome restoreRelease failed Rollback_compose_up_failed
    finish_state state_unknown Rollback_compose_up_failed rollbackFailed
  }
  health_check "$rollback_dir"
  rollback_health=$?
  [ "$rollback_health" -eq 0 ] || {
    outcome restoreRelease failed Rollback_health_verification_failed
    finish_state state_unknown Rollback_health_verification_failed rollbackFailed
  }
  activate_release "$rollback_release_id" "$release_id" || {
    outcome restoreRelease failed Rollback_activation_failed
    finish_state state_unknown Rollback_activation_failed rollbackFailed
  }
  rollback_observed_id=$rollback_release_id
  active_release_id=$rollback_release_id
  outcome restoreRelease succeeded Rollback_release_restored_and_verified
  finish_state rolled_back Rollback_release_restored_and_verified "$original_category"
}

handle_cancel() {
  if cancel_requested; then
    if [ "${compose_attempted-0}" = 1 ]; then
      restore_release cancelled
    fi
    finish_state canceled Deployment_canceled_before_service_mutation cancelled
  fi
}

handle_cancel
side_effects_started=1
intent prepareRelease Preparing_immutable_release_directory
mkdir -p "$release_root" || {
  outcome prepareRelease failed Release_root_unavailable
  finish_state failed Release_root_unavailable releasePrepareFailed
}
[ ! -L "$release_root" ] || {
  outcome prepareRelease failed Release_root_is_symbolic_link
  finish_state failed Release_root_is_symbolic_link releasePrepareFailed
}
if [ -e "$release_dir" ]; then
  [ -d "$release_dir" ] && [ ! -L "$release_dir" ] || {
    outcome prepareRelease failed Existing_release_identity_invalid
    finish_state failed Existing_release_identity_invalid releasePrepareFailed
  }
  existing_digest=$(sed -n '1p' "$release_dir/.shellspan-artifact-sha256" 2>/dev/null || true)
  [ "$existing_digest" = "$release_digest" ] || {
    outcome prepareRelease failed Existing_release_digest_conflict
    finish_state failed Existing_release_digest_conflict releasePrepareFailed
  }
else
  pending="$release_root/.pending.$approved_run_id"
  [ ! -e "$pending" ] || {
    outcome prepareRelease failed Pending_release_identity_conflict
    finish_state failed Pending_release_identity_conflict releasePrepareFailed
  }
  mkdir "$pending" "$pending/compose" || {
    outcome prepareRelease failed Release_directory_creation_failed
    finish_state failed Release_directory_creation_failed releasePrepareFailed
  }
  i=0
  while [ "$i" -lt "$compose_count" ]; do
    base=$((compose_start + i * 3))
    read_at "$base" "compose_${i}_path" || request_invalid
    compose_path=$VALUE
    read_at "$((base + 1))" "compose_${i}_file" || request_invalid
    compose_file=$VALUE
    target_file="$pending/compose/$compose_path"
    mkdir -p "$(dirname "$target_file")" || finish_state failed Release_compose_parent_failed releasePrepareFailed
    cp "$staging/$compose_file" "$target_file" || finish_state failed Release_compose_copy_failed releasePrepareFailed
    i=$((i + 1))
  done
  printf '%s\n' "$release_digest" > "$pending/.shellspan-artifact-sha256" || finish_state failed Release_digest_write_failed releasePrepareFailed
  mv "$pending" "$release_dir" || finish_state failed Release_publication_failed releasePrepareFailed
fi
outcome prepareRelease succeeded Release_directory_prepared

handle_cancel
intent loadImage Streaming_verified_archive_into_Docker
fifo="$run_dir/.docker-load.$$.fifo"
load_log="$run_dir/.docker-load.$$.log"
mkfifo "$fifo" || {
  outcome loadImage failed Docker_load_pipe_failed
  finish_state failed Docker_load_pipe_failed imageLoadFailed
}
case "$archive_compression" in
  zstd) zstd -dc "$archive" > "$fifo" 2>/dev/null & ;;
  gzip) gzip -dc "$archive" > "$fifo" 2>/dev/null & ;;
  none) cat "$archive" > "$fifo" 2>/dev/null & ;;
esac
decode_pid=$!
docker load --input "$fifo" > "$load_log" 2>&1
load_status=$?
wait "$decode_pid"
decode_status=$?
rm -f "$fifo" "$load_log"
[ "$load_status" -eq 0 ] && [ "$decode_status" -eq 0 ] || {
  outcome loadImage failed Docker_image_load_failed
  finish_state failed Docker_image_load_failed imageLoadFailed
}
observed_image_id=$(docker image inspect --format '{{.Id}}' "$image_repository:$image_tag" 2>/dev/null || true)
[ "$observed_image_id" = "$image_id" ] || {
  outcome loadImage failed Docker_image_identity_mismatch
  finish_state failed Docker_image_identity_mismatch imageMismatch
}
outcome loadImage succeeded Docker_image_loaded_and_verified

handle_cancel
intent composeConfig Generating_and_validating_runtime_owned_Compose_override
write_override "$release_dir" || {
  outcome composeConfig failed Compose_override_generation_failed
  finish_state failed Compose_override_generation_failed composeConfigFailed
}
compose_exec config "$release_dir" || {
  outcome composeConfig failed Compose_configuration_invalid
  finish_state failed Compose_configuration_invalid composeConfigFailed
}
outcome composeConfig succeeded Compose_configuration_validated

if [ "$pull_before_up" = 1 ]; then
  handle_cancel
  intent composePull Pulling_only_approved_Compose_services
  compose_exec pull "$release_dir" || {
    outcome composePull failed Compose_pull_failed
    finish_state failed Compose_pull_failed composePullFailed
  }
  outcome composePull succeeded Approved_Compose_services_pulled
fi

handle_cancel
compose_attempted=1
intent composeUp Applying_approved_Compose_release
compose_exec up "$release_dir" || {
  outcome composeUp failed Compose_up_failed_after_possible_service_mutation
  restore_release composeUpFailed
}
outcome composeUp succeeded Approved_Compose_release_applied

handle_cancel
current_step=verifyHealth
summary=Verifying_deployed_service_health
write_status verifying
write_event intent verifyHealth pending Verifying_deployed_service_health
health_check "$release_dir"
health_result=$?
if [ "$health_result" -eq 2 ]; then
  write_event outcome verifyHealth canceled Health_verification_canceled
  restore_release cancelled
fi
[ "$health_result" -eq 0 ] || {
  write_event outcome verifyHealth failed Health_verification_failed
  restore_release healthCheckFailed
}
write_event outcome verifyHealth succeeded Deployed_service_is_healthy
write_status verifying

if [ "$nginx_reload" = 1 ]; then
  handle_cancel
  current_step=validateNginx
  summary=Validating_fixed_Nginx_configuration
  write_event intent validateNginx pending Validating_fixed_Nginx_configuration
  write_status verifying
  nginx -t >/dev/null 2>&1 || {
    write_event outcome validateNginx failed Nginx_validation_failed
    restore_release nginxValidationFailed
  }
  write_event outcome validateNginx succeeded Nginx_configuration_validated
  write_status verifying

  handle_cancel
  side_effects_started=1
  intent reloadNginx Reloading_Nginx_without_service_stop
  sudo -n systemctl reload nginx >/dev/null 2>&1 || {
    outcome reloadNginx failed Nginx_reload_failed
    restore_release nginxReloadFailed
  }
  outcome reloadNginx succeeded Nginx_reloaded_without_service_stop

  handle_cancel
  current_step=reverifyHealth
  summary=Reverifying_health_after_Nginx_reload
  write_event intent reverifyHealth pending Reverifying_health_after_Nginx_reload
  write_status verifying
  health_check "$release_dir"
  rehealth_result=$?
  [ "$rehealth_result" -eq 0 ] || {
    write_event outcome reverifyHealth failed Health_failed_after_Nginx_reload
    restore_release healthCheckFailed
  }
  write_event outcome reverifyHealth succeeded Health_verified_after_Nginx_reload
  write_status verifying
fi

handle_cancel
intent activateRelease Atomically_updating_current_and_previous_release_links
activate_release "$release_id" "$rollback_release_id" || {
  outcome activateRelease failed Release_activation_failed
  restore_release activationFailed
}
active_release_id=$release_id
rollback_observed_id=$rollback_release_id
outcome activateRelease succeeded Target_release_activated

handle_cancel
finish_state succeeded Deployment_completed_and_verified ""
"#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentRemoteRunnerRequest {
    pub operation_id: String,
    pub plan_id: String,
    pub plan_digest: String,
    pub run_id: String,
    pub run_revision: u32,
    pub plan_expires_at: i64,
    pub workflow_id: String,
    pub workflow_revision: u32,
    pub artifact_reference: String,
    pub artifact_transfer_operation_id: String,
    pub source_revision: DeploymentFrozenSourceRevision,
    pub target: DeploymentTargetIdentitySnapshot,
    pub remote_root: String,
    pub release_id: String,
    pub release_digest_sha256: String,
    pub remote_staging_identity: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentRemoteRunnerCancelRequest {
    pub operation_id: String,
    pub plan_id: String,
    pub plan_digest: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeploymentReconciliationRequest {
    pub operation_id: String,
    pub plan_id: String,
    pub plan_digest: String,
    pub run_id: String,
    pub expected_run_revision: u32,
    pub artifact_transfer_operation_id: String,
    pub remote_staging_identity: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentStartupRecoveryCandidate {
    pub run_id: String,
    pub plan_id: String,
    pub plan_digest: String,
    pub status: DeploymentRunStatus,
    pub last_event_sequence: u32,
    pub reconciliation_required: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentStartupRecoveryResult {
    pub schema_version: u32,
    pub candidates: Vec<DeploymentStartupRecoveryCandidate>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentReconciliationBinding {
    pub candidate: DeploymentStartupRecoveryCandidate,
    pub artifact_transfer_operation_id: String,
    pub remote_staging_identity: String,
    pub reconciliation_operation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentReconciliationOutcome {
    TargetHealthy,
    RollbackHealthy,
    StillRunning,
    NoSideEffects,
    StateUnknown,
    ObservationStopped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentReconciliationEvidence {
    pub remote_sequence: Option<u32>,
    pub runner_identity_verified: bool,
    pub request_identity_verified: bool,
    pub ledger_verified: bool,
    pub current_release_id: Option<String>,
    pub previous_release_id: Option<String>,
    pub target_release_verified: bool,
    pub rollback_release_verified: bool,
    pub compose_services_verified: bool,
    pub health_verified: bool,
    pub side_effects_started: Option<bool>,
    pub approval_reusable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentReconciliationResult {
    pub operation_id: String,
    pub plan_id: String,
    pub run_id: String,
    pub status: DeploymentRunStatus,
    pub outcome: DeploymentReconciliationOutcome,
    pub reconciliation_required: bool,
    pub evidence: DeploymentReconciliationEvidence,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentRemoteRunnerStep {
    Revalidate,
    Lock,
    PrepareRelease,
    LoadImage,
    ComposePull,
    ComposeConfig,
    ComposeUp,
    VerifyHealth,
    ValidateNginx,
    ReloadNginx,
    ReverifyHealth,
    ActivateRelease,
    RestoreRelease,
    RecordResult,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentRemoteRunnerStatus {
    Running,
    Verifying,
    Succeeded,
    CancelRequested,
    Cancelled,
    RolledBack,
    Failed,
    StateUnknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRemoteRunnerProgress {
    pub operation_id: String,
    pub sequence: u32,
    pub step: DeploymentRemoteRunnerStep,
    pub status: DeploymentRemoteRunnerStatus,
    pub summary: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DeploymentRemoteRunnerFailureCategory {
    InvalidRequest,
    PlanNotFound,
    PlanDigestMismatch,
    PlanExpired,
    PlanNotApproved,
    WorkflowChanged,
    SourceChanged,
    TargetChanged,
    ReleaseChanged,
    TransferNotFound,
    TransferMismatch,
    StagingInvalid,
    LockConflict,
    ImageLoadFailed,
    ImageMismatch,
    ReleasePrepareFailed,
    ComposePullFailed,
    ComposeConfigFailed,
    ComposeUpFailed,
    HealthCheckFailed,
    NginxValidationFailed,
    NginxReloadFailed,
    ActivationFailed,
    RollbackFailed,
    Cancelled,
    TimedOut,
    StateUnknown,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeploymentRemoteRunnerResult {
    pub operation_id: String,
    pub plan_id: String,
    pub run_id: String,
    pub release_id: String,
    pub status: DeploymentRemoteRunnerStatus,
    pub active_release: Option<super::DeploymentReleaseIdentity>,
    pub rollback_release: Option<super::DeploymentReleaseIdentity>,
    pub reconciliation_required: bool,
    pub failure_category: Option<DeploymentRemoteRunnerFailureCategory>,
}

#[derive(Debug, Clone)]
struct RunnerFailure {
    category: DeploymentRemoteRunnerFailureCategory,
    message: String,
    ambiguous: bool,
}

impl RunnerFailure {
    fn definite(
        category: DeploymentRemoteRunnerFailureCategory,
        message: impl Into<String>,
    ) -> Self {
        Self {
            category,
            message: message.into(),
            ambiguous: false,
        }
    }

    fn ambiguous(message: impl Into<String>) -> Self {
        Self {
            category: DeploymentRemoteRunnerFailureCategory::StateUnknown,
            message: message.into(),
            ambiguous: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteRunnerState {
    InProgress,
    Verifying,
    Succeeded,
    Canceled,
    RolledBack,
    Failed,
    StateUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RemoteRunnerStatus {
    state: RemoteRunnerState,
    step: DeploymentRemoteRunnerStep,
    side_effects_started: bool,
    active_release_id: Option<String>,
    rollback_release_id: Option<String>,
    failure_category: Option<DeploymentRemoteRunnerFailureCategory>,
    sequence: u32,
    summary: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteEventPhase {
    Intent,
    Outcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RemoteRunnerEvent {
    sequence: u32,
    phase: RemoteEventPhase,
    action: DeploymentRemoteRunnerStep,
    outcome: String,
    summary: String,
}

#[derive(Debug, Clone)]
struct RemoteObservation {
    status: Option<RemoteRunnerStatus>,
    events: Vec<RemoteRunnerEvent>,
}

#[derive(Debug, Clone)]
struct RunnerLaunch {
    remote_root: String,
    run_id: String,
    operation_id: String,
    plan_digest: String,
    request_bytes: Vec<u8>,
    runner_sha256: String,
}

trait RemoteRunnerHost {
    fn install_and_start(&mut self, launch: &RunnerLaunch) -> Result<(), RunnerFailure>;
    fn observe(
        &mut self,
        launch: &RunnerLaunch,
        after_sequence: u32,
    ) -> Result<RemoteObservation, RunnerFailure>;
    fn request_cancel(&mut self, launch: &RunnerLaunch) -> Result<(), RunnerFailure>;
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sha256_bytes(bytes: &[u8]) -> String {
    hex_digest(Sha256::digest(bytes))
}

fn sha256_file(path: &Path) -> Result<String, RunnerFailure> {
    let mut file = std::fs::File::open(path).map_err(|_| {
        RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::StagingInvalid,
            "Runtime-owned artifact file is unavailable",
        )
    })?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| {
            RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::StagingInvalid,
                "Runtime-owned artifact file could not be read",
            )
        })?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(hex_digest(digest.finalize()))
}

fn parse_staging_identity(value: &str) -> Result<(&str, &str), RunnerFailure> {
    let mut parts = value.split(':');
    let prefix = parts.next().unwrap_or_default();
    let content = parts.next().unwrap_or_default();
    let manifest = parts.next().unwrap_or_default();
    if prefix != STAGING_PREFIX
        || parts.next().is_some()
        || super::validate_sha256(content).is_err()
        || super::validate_sha256(manifest).is_err()
    {
        return Err(RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::InvalidRequest,
            "Remote staging identity is invalid",
        ));
    }
    Ok((content, manifest))
}

fn validate_request(request: &DeploymentRemoteRunnerRequest) -> Result<(), RunnerFailure> {
    if !request.operation_id.starts_with(OPERATION_PREFIX)
        || !crate::execution::valid_operation_id(&request.operation_id)
        || request.run_revision == 0
        || request.workflow_revision == 0
        || request.plan_expires_at <= 0
        || !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&request.timeout_ms)
    {
        return Err(RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::InvalidRequest,
            "Remote runner request is invalid",
        ));
    }
    for (label, value) in [
        ("workflow id", request.workflow_id.as_str()),
        ("deployment run id", request.run_id.as_str()),
        ("release id", request.release_id.as_str()),
    ] {
        super::validate_identifier(label, value, 128).map_err(|error| {
            RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::InvalidRequest,
                error.to_string(),
            )
        })?;
    }
    super::validate_sha256(&request.plan_digest).map_err(|error| {
        RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::InvalidRequest,
            error.to_string(),
        )
    })?;
    super::validate_sha256(&request.release_digest_sha256).map_err(|error| {
        RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::InvalidRequest,
            error.to_string(),
        )
    })?;
    super::validate_artifact_reference(&request.artifact_reference).map_err(|error| {
        RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::InvalidRequest,
            error.to_string(),
        )
    })?;
    super::validate_remote_root(&request.remote_root).map_err(|error| {
        RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::InvalidRequest,
            error.to_string(),
        )
    })?;
    if request.plan_id != format!("plan-{}", request.plan_digest)
        || !super::artifact_transfer::valid_artifact_transfer_operation_id(
            &request.artifact_transfer_operation_id,
        )
    {
        return Err(RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::InvalidRequest,
            "Remote runner frozen identities are invalid",
        ));
    }
    parse_staging_identity(&request.remote_staging_identity)?;
    Ok(())
}

fn map_plan_error(error: &str) -> DeploymentRemoteRunnerFailureCategory {
    if error.contains("PLAN_NOT_FOUND") {
        DeploymentRemoteRunnerFailureCategory::PlanNotFound
    } else if error.contains("PLAN_EXPIRED") {
        DeploymentRemoteRunnerFailureCategory::PlanExpired
    } else if error.contains("PLAN_INTEGRITY") {
        DeploymentRemoteRunnerFailureCategory::PlanDigestMismatch
    } else {
        DeploymentRemoteRunnerFailureCategory::WorkflowChanged
    }
}

fn required_actions_match(
    actions: &[ApprovedDeploymentAction],
    workflow: &super::DeploymentWorkflowRecord,
    has_rollback: bool,
) -> bool {
    let required = [
        ApprovedDeploymentAction::StageRelease,
        ApprovedDeploymentAction::PrepareRelease,
        ApprovedDeploymentAction::LoadImage,
        ApprovedDeploymentAction::ComposeConfig,
        ApprovedDeploymentAction::ComposeUp,
        ApprovedDeploymentAction::ActivateRelease,
    ];
    if required.iter().any(|action| !actions.contains(action)) {
        return false;
    }
    if workflow.definition.compose.pull_before_up
        != actions.contains(&ApprovedDeploymentAction::ComposePull)
    {
        return false;
    }
    if !actions.contains(&ApprovedDeploymentAction::VerifyHealth) {
        return false;
    }
    if workflow.definition.reload_nginx_after_healthy
        && [
            ApprovedDeploymentAction::ValidateNginx,
            ApprovedDeploymentAction::ReloadNginx,
            ApprovedDeploymentAction::ReverifyHealth,
        ]
        .iter()
        .any(|action| !actions.contains(action))
    {
        return false;
    }
    has_rollback == actions.contains(&ApprovedDeploymentAction::AutomaticRestore)
}

fn revalidate_frozen_inputs(
    database: &Database,
    artifact_staging_root: &Path,
    request: &DeploymentRemoteRunnerRequest,
    cancellation: &CancellationHandle,
    deadline: Instant,
    require_approved: bool,
    expected_plan: Option<&super::DeploymentStoredPlanRecord>,
) -> Result<
    (
        super::DeploymentStoredPlanRecord,
        VerifiedDeploymentArtifact,
        super::DeploymentWorkflowRecord,
    ),
    RunnerFailure,
> {
    let plan = if require_approved {
        get_deployment_plan(database, &request.plan_id).map_err(|error| {
            RunnerFailure::definite(
                map_plan_error(&error),
                "Deployment plan failed runtime revalidation",
            )
        })?
    } else {
        expected_plan.cloned().ok_or_else(|| {
            RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::Internal,
                "Completion revalidation is missing the frozen approved plan",
            )
        })?
    };
    let run = database
        .get_deployment_run(&request.run_id)
        .map_err(|_| {
            RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::Internal,
                "Deployment run could not be loaded",
            )
        })?
        .ok_or_else(|| {
            RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::PlanNotFound,
                "Deployment run no longer exists",
            )
        })?;
    if plan.plan_digest != request.plan_digest
        || plan.run_id != request.run_id
        || plan.expires_at != request.plan_expires_at
        || run.approval_digest != request.plan_digest
        || run.approval_summary != plan.approval_summary
    {
        return Err(RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::PlanDigestMismatch,
            "Deployment plan binding changed",
        ));
    }
    if require_approved
        && (plan.status != DeploymentRunStatus::Approved
            || run.last_event_sequence != request.run_revision)
    {
        return Err(RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::PlanNotApproved,
            "Deployment plan is not at the exact approved revision",
        ));
    }
    if !require_approved
        && !matches!(
            run.status,
            DeploymentRunStatus::InProgress
                | DeploymentRunStatus::Verifying
                | DeploymentRunStatus::CancelRequested
        )
    {
        return Err(RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::PlanNotApproved,
            "Deployment run left its active execution state",
        ));
    }
    let summary = &plan.approval_summary;
    if summary.artifact_reference.as_deref() != Some(&request.artifact_reference)
        || summary.workflow_id != request.workflow_id
        || summary.workflow_revision != request.workflow_revision
        || summary.remote_root != request.remote_root
        || summary.frozen.source_revision != request.source_revision
        || summary.frozen.target != request.target
        || summary.frozen.target_release.release_id != request.release_id
        || summary.frozen.target_release.artifact_digest_sha256 != request.release_digest_sha256
    {
        return Err(RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::ReleaseChanged,
            "Frozen deployment identities no longer match the approved plan",
        ));
    }
    let workflow = database
        .get_deployment_workflow(&request.workflow_id)
        .map_err(|_| {
            RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::Internal,
                "Deployment workflow could not be loaded",
            )
        })?
        .ok_or_else(|| {
            RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::WorkflowChanged,
                "Deployment workflow no longer exists",
            )
        })?;
    if !workflow.enabled
        || workflow.revision != request.workflow_revision
        || !required_actions_match(
            &summary.actions,
            &workflow,
            summary.frozen.rollback_release.is_some(),
        )
    {
        return Err(RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::WorkflowChanged,
            "Deployment workflow or approved fixed actions changed",
        ));
    }
    let profile = database
        .get_profile(&workflow.connection_profile_id)
        .map_err(|_| {
            RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::Internal,
                "Deployment profile could not be loaded",
            )
        })?
        .ok_or_else(|| {
            RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::TargetChanged,
                "Deployment profile no longer exists",
            )
        })?;
    if target_identity(&profile).ok().as_ref() != Some(&request.target) {
        return Err(RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::TargetChanged,
            "Deployment target identity changed",
        ));
    }
    let source = inspect_deployment_artifact_source_with_handle(
        database,
        &request.workflow_id,
        request.workflow_revision,
        cancellation,
        deadline,
    )
    .map_err(|_| {
        RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::SourceChanged,
            "Deployment source failed runtime revalidation",
        )
    })?;
    if source != request.source_revision {
        return Err(RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::SourceChanged,
            "Deployment source changed after approval",
        ));
    }
    let artifact = verify_deployment_artifact(artifact_staging_root, &request.artifact_reference)
        .map_err(|_| {
        RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::StagingInvalid,
            "Runtime-owned artifact failed integrity verification",
        )
    })?;
    let (content_identity, manifest_digest) =
        parse_staging_identity(&request.remote_staging_identity)?;
    if artifact.manifest.workflow_id != request.workflow_id
        || artifact.manifest.workflow_revision != request.workflow_revision
        || artifact.manifest.source_revision != request.source_revision
        || artifact.manifest.release_id != request.release_id
        || artifact.manifest.archive.sha256 != request.release_digest_sha256
        || artifact.manifest.content_identity_sha256 != content_identity
        || artifact.manifest.manifest_digest_sha256 != manifest_digest
    {
        return Err(RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::ReleaseChanged,
            "Runtime-owned artifact or staging identity changed",
        ));
    }
    let receipt = database
        .get_deployment_transfer_receipt(&request.artifact_transfer_operation_id)
        .map_err(|_| {
            RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::Internal,
                "Deployment transfer receipt could not be loaded",
            )
        })?
        .ok_or_else(|| {
            RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::TransferNotFound,
                "Successful deployment transfer receipt was not found",
            )
        })?;
    if receipt.run_id != request.run_id
        || receipt.plan_id != request.plan_id
        || receipt.plan_digest != request.plan_digest
        || receipt.request.workflow_id != request.workflow_id
        || receipt.request.workflow_revision != request.workflow_revision
        || receipt.request.artifact_reference != request.artifact_reference
        || receipt.request.source_revision != request.source_revision
        || receipt.request.target != request.target
        || receipt.request.remote_root != request.remote_root
        || receipt.request.release_id != request.release_id
        || receipt.request.release_digest_sha256 != request.release_digest_sha256
        || receipt.result.status
            != super::artifact_transfer::DeploymentArtifactTransferStatus::Succeeded
        || receipt.result.remote_staging_identity.as_deref()
            != Some(&request.remote_staging_identity)
        || receipt.result.remote_digest_sha256.as_deref() != Some(&request.release_digest_sha256)
    {
        return Err(RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::TransferMismatch,
            "Deployment transfer receipt does not match the runner request",
        ));
    }
    Ok((plan, artifact, workflow))
}

fn request_line(key: &str, value: impl std::fmt::Display, output: &mut String) {
    output.push_str(key);
    output.push('\t');
    output.push_str(&value.to_string());
    output.push('\n');
}

fn build_runner_request(
    request: &DeploymentRemoteRunnerRequest,
    plan: &super::DeploymentStoredPlanRecord,
    artifact: &VerifiedDeploymentArtifact,
    workflow_record: &super::DeploymentWorkflowRecord,
    runner_sha256: &str,
) -> Result<Vec<u8>, RunnerFailure> {
    let workflow_health =
        plan.approval_summary.frozen.target_release.release_id == request.release_id;
    if !workflow_health {
        return Err(RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::ReleaseChanged,
            "Approved target release changed",
        ));
    }
    let manifest_file_sha256 = sha256_file(&artifact.directory().join("manifest.json"))?;
    let workflow = &plan.approval_summary;
    let mut body = String::new();
    request_line("schema_version", REQUEST_SCHEMA_VERSION, &mut body);
    request_line("runner_version", RUNNER_VERSION, &mut body);
    request_line("runner_sha256", runner_sha256, &mut body);
    request_line("operation_id", &request.operation_id, &mut body);
    request_line("plan_id", &request.plan_id, &mut body);
    request_line("plan_digest", &request.plan_digest, &mut body);
    request_line("run_id", &request.run_id, &mut body);
    request_line(
        "expires_at_seconds",
        request.plan_expires_at / 1_000,
        &mut body,
    );
    request_line("remote_root", &request.remote_root, &mut body);
    request_line(
        "content_identity",
        &artifact.manifest.content_identity_sha256,
        &mut body,
    );
    request_line(
        "manifest_digest",
        &artifact.manifest.manifest_digest_sha256,
        &mut body,
    );
    request_line("manifest_file_sha256", manifest_file_sha256, &mut body);
    request_line("release_id", &request.release_id, &mut body);
    request_line("release_digest", &request.release_digest_sha256, &mut body);
    request_line(
        "archive_file",
        &artifact.manifest.archive.file_name,
        &mut body,
    );
    request_line(
        "archive_compression",
        match artifact.manifest.archive.compression {
            super::DeploymentArtifactCompression::Zstd => "zstd",
            super::DeploymentArtifactCompression::Gzip => "gzip",
            super::DeploymentArtifactCompression::None => "none",
        },
        &mut body,
    );
    request_line(
        "archive_sha256",
        &artifact.manifest.archive.sha256,
        &mut body,
    );
    request_line(
        "image_repository",
        &artifact.manifest.image.repository,
        &mut body,
    );
    request_line("image_tag", &artifact.manifest.image.tag, &mut body);
    request_line("image_id", &artifact.manifest.image.image_id, &mut body);
    request_line("compose_project", &workflow.compose_project, &mut body);
    request_line(
        "pull_before_up",
        u8::from(
            workflow
                .actions
                .contains(&ApprovedDeploymentAction::ComposePull),
        ),
        &mut body,
    );
    let health = workflow_record.definition.health_check.as_ref();
    request_line("health_enabled", u8::from(health.is_some()), &mut body);
    request_line(
        "health_path",
        health.map(|check| check.path.as_str()).unwrap_or(""),
        &mut body,
    );
    request_line(
        "health_status",
        health.map(|check| check.expected_status).unwrap_or(0),
        &mut body,
    );
    request_line(
        "health_timeout",
        health.map(|check| check.timeout_seconds).unwrap_or(0),
        &mut body,
    );
    request_line(
        "nginx_reload",
        u8::from(
            workflow
                .actions
                .contains(&ApprovedDeploymentAction::ReloadNginx),
        ),
        &mut body,
    );
    request_line(
        "rollback_release_id",
        workflow
            .frozen
            .rollback_release
            .as_ref()
            .map(|release| release.release_id.as_str())
            .unwrap_or(""),
        &mut body,
    );
    request_line(
        "rollback_release_digest",
        workflow
            .frozen
            .rollback_release
            .as_ref()
            .map(|release| release.artifact_digest_sha256.as_str())
            .unwrap_or(""),
        &mut body,
    );
    request_line(
        "compose_count",
        artifact.manifest.compose_files.len(),
        &mut body,
    );
    for (index, compose) in artifact.manifest.compose_files.iter().enumerate() {
        request_line(&format!("compose_{index}_path"), &compose.path, &mut body);
        request_line(
            &format!("compose_{index}_file"),
            &compose.file_name,
            &mut body,
        );
        request_line(
            &format!("compose_{index}_sha256"),
            &compose.sha256,
            &mut body,
        );
    }
    request_line("service_count", workflow.services.len(), &mut body);
    for (index, service) in workflow.services.iter().enumerate() {
        request_line(&format!("service_{index}"), service, &mut body);
    }
    request_line("end", 1, &mut body);
    let mut request_file = String::new();
    request_line(
        "request_digest",
        sha256_bytes(body.as_bytes()),
        &mut request_file,
    );
    request_file.push_str(&body);
    if request_file.len() > MAX_REMOTE_FILE_BYTES {
        return Err(RunnerFailure::definite(
            DeploymentRemoteRunnerFailureCategory::InvalidRequest,
            "Remote runner request exceeded the safety limit",
        ));
    }
    Ok(request_file.into_bytes())
}

fn append_event_retry(
    database: &Database,
    run_id: &str,
    event: DeploymentEventWrite,
) -> Result<(), RunnerFailure> {
    for _ in 0..3 {
        let run = database
            .get_deployment_run(run_id)
            .map_err(|_| RunnerFailure::ambiguous("Deployment run could not be reloaded"))?
            .ok_or_else(|| RunnerFailure::ambiguous("Deployment run disappeared"))?;
        match database.append_deployment_run_event_atomic(
            run_id,
            run.last_event_sequence,
            run.status,
            &DeploymentEventWrite {
                status: Some(run.status),
                ..event.clone()
            },
        ) {
            Ok(()) => return Ok(()),
            Err(error) if error == "REVISION_CONFLICT" => continue,
            Err(_) => {
                return Err(RunnerFailure::ambiguous(
                    "Deployment event could not be recorded",
                ))
            }
        }
    }
    Err(RunnerFailure::ambiguous(
        "Deployment event revision remained in conflict",
    ))
}

fn transition_retry(
    database: &Database,
    run_id: &str,
    next_status: DeploymentRunStatus,
    event_kind: DeploymentEventKind,
    summary: &str,
    payload: serde_json::Value,
) -> Result<(), RunnerFailure> {
    for _ in 0..3 {
        let run = database
            .get_deployment_run(run_id)
            .map_err(|_| RunnerFailure::ambiguous("Deployment run could not be reloaded"))?
            .ok_or_else(|| RunnerFailure::ambiguous("Deployment run disappeared"))?;
        if run.status == next_status {
            return Ok(());
        }
        if !run.status.can_transition_to(next_status) {
            return Err(RunnerFailure::ambiguous(
                "Deployment run cannot enter the observed remote state",
            ));
        }
        match database.transition_deployment_run_atomic(
            run_id,
            run.last_event_sequence,
            run.status,
            next_status,
            &DeploymentEventWrite {
                event_kind,
                status: Some(next_status),
                summary: summary.into(),
                payload: Some(payload.clone()),
            },
        ) {
            Ok(()) => return Ok(()),
            Err(error) if error == "REVISION_CONFLICT" => continue,
            Err(_) => {
                return Err(RunnerFailure::ambiguous(
                    "Deployment state could not be recorded",
                ))
            }
        }
    }
    Err(RunnerFailure::ambiguous(
        "Deployment state revision remained in conflict",
    ))
}

fn progress_status(state: RemoteRunnerState) -> DeploymentRemoteRunnerStatus {
    match state {
        RemoteRunnerState::InProgress => DeploymentRemoteRunnerStatus::Running,
        RemoteRunnerState::Verifying => DeploymentRemoteRunnerStatus::Verifying,
        RemoteRunnerState::Succeeded => DeploymentRemoteRunnerStatus::Succeeded,
        RemoteRunnerState::Canceled => DeploymentRemoteRunnerStatus::Cancelled,
        RemoteRunnerState::RolledBack => DeploymentRemoteRunnerStatus::RolledBack,
        RemoteRunnerState::Failed => DeploymentRemoteRunnerStatus::Failed,
        RemoteRunnerState::StateUnknown => DeploymentRemoteRunnerStatus::StateUnknown,
    }
}

fn terminal_result(
    request: &DeploymentRemoteRunnerRequest,
    plan: &super::DeploymentStoredPlanRecord,
    status: DeploymentRemoteRunnerStatus,
    active_release_id: Option<String>,
    rollback_release_id: Option<String>,
    failure_category: Option<DeploymentRemoteRunnerFailureCategory>,
) -> DeploymentRemoteRunnerResult {
    let release_for = |id: Option<String>| {
        id.and_then(|id| {
            std::iter::once(&plan.approval_summary.frozen.target_release)
                .chain(plan.approval_summary.frozen.current_release.as_ref())
                .chain(plan.approval_summary.frozen.rollback_release.as_ref())
                .find(|release| release.release_id == id)
                .cloned()
        })
    };
    DeploymentRemoteRunnerResult {
        operation_id: request.operation_id.clone(),
        plan_id: request.plan_id.clone(),
        run_id: request.run_id.clone(),
        release_id: request.release_id.clone(),
        reconciliation_required: status == DeploymentRemoteRunnerStatus::StateUnknown,
        active_release: release_for(active_release_id),
        rollback_release: release_for(rollback_release_id),
        status,
        failure_category,
    }
}

fn failure_result(
    request: &DeploymentRemoteRunnerRequest,
    category: DeploymentRemoteRunnerFailureCategory,
    ambiguous: bool,
) -> DeploymentRemoteRunnerResult {
    DeploymentRemoteRunnerResult {
        operation_id: request.operation_id.clone(),
        plan_id: request.plan_id.clone(),
        run_id: request.run_id.clone(),
        release_id: request.release_id.clone(),
        status: if ambiguous {
            DeploymentRemoteRunnerStatus::StateUnknown
        } else if category == DeploymentRemoteRunnerFailureCategory::Cancelled {
            DeploymentRemoteRunnerStatus::Cancelled
        } else {
            DeploymentRemoteRunnerStatus::Failed
        },
        active_release: None,
        rollback_release: None,
        reconciliation_required: ambiguous,
        failure_category: Some(if ambiguous {
            DeploymentRemoteRunnerFailureCategory::StateUnknown
        } else {
            category
        }),
    }
}

fn run_with_host(
    database: &Database,
    artifact_staging_root: &Path,
    cancellations: &ExecutionCancellationRegistry,
    request: DeploymentRemoteRunnerRequest,
    host: &mut dyn RemoteRunnerHost,
    emit: &mut dyn FnMut(DeploymentRemoteRunnerProgress),
) -> DeploymentRemoteRunnerResult {
    if let Err(failure) = validate_request(&request) {
        return failure_result(&request, failure.category, failure.ambiguous);
    }
    let cancellation = match cancellations.register(request.operation_id.clone()) {
        Ok(handle) => handle,
        Err(_) => {
            return failure_result(
                &request,
                DeploymentRemoteRunnerFailureCategory::InvalidRequest,
                false,
            )
        }
    };
    let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
    let (plan, artifact, workflow) = match revalidate_frozen_inputs(
        database,
        artifact_staging_root,
        &request,
        &cancellation,
        deadline,
        true,
        None,
    ) {
        Ok(values) => values,
        Err(failure) => return failure_result(&request, failure.category, failure.ambiguous),
    };
    let runner_sha256 = sha256_bytes(REMOTE_RUNNER_SCRIPT.as_bytes());
    let request_bytes =
        match build_runner_request(&request, &plan, &artifact, &workflow, &runner_sha256) {
            Ok(bytes) => bytes,
            Err(failure) => return failure_result(&request, failure.category, failure.ambiguous),
        };
    let launch = RunnerLaunch {
        remote_root: request.remote_root.clone(),
        run_id: request.run_id.clone(),
        operation_id: request.operation_id.clone(),
        plan_digest: request.plan_digest.clone(),
        request_bytes,
        runner_sha256,
    };
    if let Err(failure) = transition_retry(
        database,
        &request.run_id,
        DeploymentRunStatus::InProgress,
        DeploymentEventKind::StatusChanged,
        "Detached fixed-purpose remote runner launch intent recorded",
        serde_json::json!({
            "operationId": request.operation_id,
            "runnerVersion": RUNNER_VERSION,
            "runnerSha256": launch.runner_sha256,
            "artifactTransferOperationId": request.artifact_transfer_operation_id,
            "remoteStagingIdentity": request.remote_staging_identity,
            "phase": "intent",
        }),
    ) {
        return failure_result(&request, failure.category, true);
    }
    if let Err(failure) = host.install_and_start(&launch) {
        let next = if failure.ambiguous {
            DeploymentRunStatus::StateUnknown
        } else {
            DeploymentRunStatus::Failed
        };
        let _ = transition_retry(
            database,
            &request.run_id,
            next,
            if failure.ambiguous {
                DeploymentEventKind::StatusChanged
            } else {
                DeploymentEventKind::RunFailed
            },
            if failure.ambiguous {
                "Remote runner launch completion is unknown; reconciliation is required"
            } else {
                "Remote runner launch failed before execution"
            },
            serde_json::json!({
                "operationId": request.operation_id,
                "failureCategory": format!("{:?}", failure.category),
                "reconciliationRequired": failure.ambiguous,
            }),
        );
        return failure_result(&request, failure.category, failure.ambiguous);
    }

    let mut observed_sequence = 0_u32;
    let mut emitted_sequence = 0_u32;
    let mut cancel_sent = false;
    let mut poll_failures = 0_usize;
    loop {
        if Instant::now() >= deadline {
            cancellation.try_timeout();
        }
        if matches!(
            cancellation.terminal_state(),
            ExecutionTerminalState::Cancelled | ExecutionTerminalState::TimedOut
        ) && !cancel_sent
        {
            let _ = host.request_cancel(&launch);
            cancel_sent = true;
            let _ = transition_retry(
                database,
                &request.run_id,
                DeploymentRunStatus::CancelRequested,
                DeploymentEventKind::CancellationRequested,
                "Remote runner cancellation requested",
                serde_json::json!({ "operationId": request.operation_id }),
            );
        }
        if cancellation.terminal_state() == ExecutionTerminalState::TimedOut {
            let _ = transition_retry(
                database,
                &request.run_id,
                DeploymentRunStatus::StateUnknown,
                DeploymentEventKind::StatusChanged,
                "Remote runner timed out before completion could be proved",
                serde_json::json!({ "operationId": request.operation_id, "reconciliationRequired": true }),
            );
            return failure_result(
                &request,
                DeploymentRemoteRunnerFailureCategory::TimedOut,
                true,
            );
        }

        let observation = match host.observe(&launch, observed_sequence) {
            Ok(value) => {
                poll_failures = 0;
                value
            }
            Err(failure) => {
                poll_failures = poll_failures.saturating_add(1);
                if poll_failures < MAX_CONSECUTIVE_POLL_FAILURES && Instant::now() < deadline {
                    std::thread::sleep(POLL_INTERVAL);
                    continue;
                }
                let _ = transition_retry(
                    database,
                    &request.run_id,
                    DeploymentRunStatus::StateUnknown,
                    DeploymentEventKind::StatusChanged,
                    "Remote runner state could not be reconciled after connection loss",
                    serde_json::json!({ "operationId": request.operation_id, "reconciliationRequired": true }),
                );
                return failure_result(&request, failure.category, true);
            }
        };
        for event in observation.events {
            if event.sequence <= observed_sequence {
                continue;
            }
            if event.sequence != observed_sequence.saturating_add(1) {
                let _ = transition_retry(
                    database,
                    &request.run_id,
                    DeploymentRunStatus::StateUnknown,
                    DeploymentEventKind::StatusChanged,
                    "Remote runner event sequence is incomplete",
                    serde_json::json!({ "operationId": request.operation_id, "reconciliationRequired": true }),
                );
                return failure_result(
                    &request,
                    DeploymentRemoteRunnerFailureCategory::StateUnknown,
                    true,
                );
            }
            observed_sequence = event.sequence;
            if append_event_retry(
                database,
                &request.run_id,
                DeploymentEventWrite {
                    event_kind: DeploymentEventKind::StatusChanged,
                    status: None,
                    summary: format!(
                        "Remote {} for {}: {}",
                        match event.phase {
                            RemoteEventPhase::Intent => "intent",
                            RemoteEventPhase::Outcome => "outcome",
                        },
                        step_name(event.action),
                        event.summary
                    ),
                    payload: Some(serde_json::json!({
                        "operationId": request.operation_id,
                        "remoteSequence": event.sequence,
                        "phase": match event.phase { RemoteEventPhase::Intent => "intent", RemoteEventPhase::Outcome => "outcome" },
                        "action": step_name(event.action),
                        "outcome": event.outcome,
                    })),
                },
            )
            .is_err()
            {
                return failure_result(
                    &request,
                    DeploymentRemoteRunnerFailureCategory::StateUnknown,
                    true,
                );
            }
        }
        let Some(status) = observation.status else {
            std::thread::sleep(POLL_INTERVAL);
            continue;
        };
        emitted_sequence = emitted_sequence.saturating_add(1);
        emit(DeploymentRemoteRunnerProgress {
            operation_id: request.operation_id.clone(),
            sequence: emitted_sequence,
            step: status.step,
            status: progress_status(status.state),
            summary: status.summary.clone(),
        });
        if matches!(
            status.state,
            RemoteRunnerState::Verifying | RemoteRunnerState::Succeeded
        ) {
            let _ = transition_retry(
                database,
                &request.run_id,
                DeploymentRunStatus::Verifying,
                DeploymentEventKind::StatusChanged,
                "Remote deployment effects completed; verification is running",
                serde_json::json!({ "operationId": request.operation_id }),
            );
        }
        if matches!(
            status.state,
            RemoteRunnerState::InProgress | RemoteRunnerState::Verifying
        ) {
            std::thread::sleep(POLL_INTERVAL);
            continue;
        }

        let completion_registry = ExecutionCancellationRegistry::default();
        let completion_handle = match completion_registry.register(format!(
            "deployment-remote-runner:completion-{}",
            uuid::Uuid::new_v4()
        )) {
            Ok(handle) => handle,
            Err(_) => {
                return failure_result(
                    &request,
                    DeploymentRemoteRunnerFailureCategory::StateUnknown,
                    true,
                )
            }
        };
        if revalidate_frozen_inputs(
            database,
            artifact_staging_root,
            &request,
            &completion_handle,
            deadline,
            false,
            Some(&plan),
        )
        .is_err()
        {
            let _ = transition_retry(
                database,
                &request.run_id,
                DeploymentRunStatus::StateUnknown,
                DeploymentEventKind::StatusChanged,
                "Completion-time identity revalidation failed",
                serde_json::json!({ "operationId": request.operation_id, "reconciliationRequired": true }),
            );
            return failure_result(
                &request,
                DeploymentRemoteRunnerFailureCategory::StateUnknown,
                true,
            );
        }
        cancellation.try_finish();
        let cancellation_won = database
            .get_deployment_run(&request.run_id)
            .ok()
            .flatten()
            .is_some_and(|run| run.status == DeploymentRunStatus::CancelRequested);
        let (next, event_kind, summary, result_status) = match status.state {
            RemoteRunnerState::Succeeded if cancellation_won => (
                DeploymentRunStatus::Failed,
                DeploymentEventKind::RunFailed,
                "Cancellation won locally after the remote runner had already committed success",
                DeploymentRemoteRunnerStatus::Failed,
            ),
            RemoteRunnerState::Succeeded => (
                DeploymentRunStatus::Succeeded,
                DeploymentEventKind::RunSucceeded,
                "Deployment completed and the target release is healthy",
                DeploymentRemoteRunnerStatus::Succeeded,
            ),
            RemoteRunnerState::Canceled => (
                DeploymentRunStatus::Canceled,
                DeploymentEventKind::RunCanceled,
                "Deployment canceled before an approved action remained active",
                DeploymentRemoteRunnerStatus::Cancelled,
            ),
            RemoteRunnerState::RolledBack => {
                (
                    if cancellation_won {
                        DeploymentRunStatus::Canceled
                    } else {
                        DeploymentRunStatus::Failed
                    },
                    if cancellation_won {
                        DeploymentEventKind::RunCanceled
                    } else {
                        DeploymentEventKind::RunFailed
                    },
                    "Deployment did not complete; the frozen rollback release was restored and verified",
                    DeploymentRemoteRunnerStatus::RolledBack,
                )
            }
            RemoteRunnerState::Failed => (
                DeploymentRunStatus::Failed,
                DeploymentEventKind::RunFailed,
                "Deployment failed before an uncertain remote state remained",
                DeploymentRemoteRunnerStatus::Failed,
            ),
            RemoteRunnerState::StateUnknown => (
                DeploymentRunStatus::StateUnknown,
                DeploymentEventKind::StatusChanged,
                "Remote runner could not prove the active release; reconciliation is required",
                DeploymentRemoteRunnerStatus::StateUnknown,
            ),
            RemoteRunnerState::InProgress | RemoteRunnerState::Verifying => unreachable!(),
        };
        let _ = transition_retry(
            database,
            &request.run_id,
            next,
            event_kind,
            summary,
            serde_json::json!({
                "operationId": request.operation_id,
                "remoteSequence": status.sequence,
                "activeReleaseId": status.active_release_id,
                "rollbackReleaseId": status.rollback_release_id,
                "reconciliationRequired": next == DeploymentRunStatus::StateUnknown,
            }),
        );
        return terminal_result(
            &request,
            &plan,
            result_status,
            status.active_release_id,
            status.rollback_release_id,
            status.failure_category.or_else(|| {
                (cancellation_won && status.state == RemoteRunnerState::Succeeded)
                    .then_some(DeploymentRemoteRunnerFailureCategory::Cancelled)
            }),
        );
    }
}

fn step_name(step: DeploymentRemoteRunnerStep) -> &'static str {
    match step {
        DeploymentRemoteRunnerStep::Revalidate => "revalidate",
        DeploymentRemoteRunnerStep::Lock => "lock",
        DeploymentRemoteRunnerStep::PrepareRelease => "prepareRelease",
        DeploymentRemoteRunnerStep::LoadImage => "loadImage",
        DeploymentRemoteRunnerStep::ComposePull => "composePull",
        DeploymentRemoteRunnerStep::ComposeConfig => "composeConfig",
        DeploymentRemoteRunnerStep::ComposeUp => "composeUp",
        DeploymentRemoteRunnerStep::VerifyHealth => "verifyHealth",
        DeploymentRemoteRunnerStep::ValidateNginx => "validateNginx",
        DeploymentRemoteRunnerStep::ReloadNginx => "reloadNginx",
        DeploymentRemoteRunnerStep::ReverifyHealth => "reverifyHealth",
        DeploymentRemoteRunnerStep::ActivateRelease => "activateRelease",
        DeploymentRemoteRunnerStep::RestoreRelease => "restoreRelease",
        DeploymentRemoteRunnerStep::RecordResult => "recordResult",
    }
}

fn parse_step(value: &str) -> Result<DeploymentRemoteRunnerStep, RunnerFailure> {
    match value {
        "revalidate" => Ok(DeploymentRemoteRunnerStep::Revalidate),
        "lock" => Ok(DeploymentRemoteRunnerStep::Lock),
        "prepareRelease" => Ok(DeploymentRemoteRunnerStep::PrepareRelease),
        "loadImage" => Ok(DeploymentRemoteRunnerStep::LoadImage),
        "composePull" => Ok(DeploymentRemoteRunnerStep::ComposePull),
        "composeConfig" => Ok(DeploymentRemoteRunnerStep::ComposeConfig),
        "composeUp" => Ok(DeploymentRemoteRunnerStep::ComposeUp),
        "verifyHealth" => Ok(DeploymentRemoteRunnerStep::VerifyHealth),
        "validateNginx" => Ok(DeploymentRemoteRunnerStep::ValidateNginx),
        "reloadNginx" => Ok(DeploymentRemoteRunnerStep::ReloadNginx),
        "reverifyHealth" => Ok(DeploymentRemoteRunnerStep::ReverifyHealth),
        "activateRelease" => Ok(DeploymentRemoteRunnerStep::ActivateRelease),
        "restoreRelease" => Ok(DeploymentRemoteRunnerStep::RestoreRelease),
        "recordResult" => Ok(DeploymentRemoteRunnerStep::RecordResult),
        _ => Err(RunnerFailure::ambiguous("Remote runner step is unknown")),
    }
}

fn parse_failure_category(
    value: &str,
) -> Result<Option<DeploymentRemoteRunnerFailureCategory>, RunnerFailure> {
    let category = match value {
        "" => return Ok(None),
        "planExpired" => DeploymentRemoteRunnerFailureCategory::PlanExpired,
        "lockConflict" => DeploymentRemoteRunnerFailureCategory::LockConflict,
        "stagingInvalid" => DeploymentRemoteRunnerFailureCategory::StagingInvalid,
        "imageLoadFailed" => DeploymentRemoteRunnerFailureCategory::ImageLoadFailed,
        "imageMismatch" => DeploymentRemoteRunnerFailureCategory::ImageMismatch,
        "releasePrepareFailed" => DeploymentRemoteRunnerFailureCategory::ReleasePrepareFailed,
        "composePullFailed" => DeploymentRemoteRunnerFailureCategory::ComposePullFailed,
        "composeConfigFailed" => DeploymentRemoteRunnerFailureCategory::ComposeConfigFailed,
        "composeUpFailed" => DeploymentRemoteRunnerFailureCategory::ComposeUpFailed,
        "healthCheckFailed" => DeploymentRemoteRunnerFailureCategory::HealthCheckFailed,
        "nginxValidationFailed" => DeploymentRemoteRunnerFailureCategory::NginxValidationFailed,
        "nginxReloadFailed" => DeploymentRemoteRunnerFailureCategory::NginxReloadFailed,
        "activationFailed" => DeploymentRemoteRunnerFailureCategory::ActivationFailed,
        "rollbackFailed" => DeploymentRemoteRunnerFailureCategory::RollbackFailed,
        "cancelled" => DeploymentRemoteRunnerFailureCategory::Cancelled,
        "timedOut" => DeploymentRemoteRunnerFailureCategory::TimedOut,
        "stateUnknown" => DeploymentRemoteRunnerFailureCategory::StateUnknown,
        "internal" => DeploymentRemoteRunnerFailureCategory::Internal,
        _ => {
            return Err(RunnerFailure::ambiguous(
                "Remote runner failure category is unknown",
            ))
        }
    };
    Ok(Some(category))
}

fn parse_key_value_document(bytes: &[u8]) -> Result<BTreeMap<String, String>, RunnerFailure> {
    if bytes.is_empty() || bytes.len() > MAX_REMOTE_FILE_BYTES {
        return Err(RunnerFailure::ambiguous(
            "Remote runner document size is invalid",
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| RunnerFailure::ambiguous("Remote runner document is not UTF-8"))?;
    let mut fields = BTreeMap::new();
    for line in text.lines() {
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| RunnerFailure::ambiguous("Remote runner document is malformed"))?;
        if key.is_empty()
            || !key
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
            || fields.insert(key.to_string(), value.to_string()).is_some()
        {
            return Err(RunnerFailure::ambiguous(
                "Remote runner document contains unknown structure",
            ));
        }
    }
    Ok(fields)
}

fn take_exact(fields: &mut BTreeMap<String, String>, key: &str) -> Result<String, RunnerFailure> {
    fields
        .remove(key)
        .ok_or_else(|| RunnerFailure::ambiguous("Remote runner document is incomplete"))
}

fn optional_id(value: String) -> Result<Option<String>, RunnerFailure> {
    if value.is_empty() {
        return Ok(None);
    }
    super::validate_identifier("remote release id", &value, 128)
        .map_err(|_| RunnerFailure::ambiguous("Remote release identity is invalid"))?;
    Ok(Some(value))
}

fn parse_remote_status(bytes: &[u8]) -> Result<RemoteRunnerStatus, RunnerFailure> {
    let mut fields = parse_key_value_document(bytes)?;
    if take_exact(&mut fields, "schemaVersion")? != "1" {
        return Err(RunnerFailure::ambiguous(
            "Remote status schema is unsupported",
        ));
    }
    let state = match take_exact(&mut fields, "state")?.as_str() {
        "in_progress" => RemoteRunnerState::InProgress,
        "verifying" => RemoteRunnerState::Verifying,
        "succeeded" => RemoteRunnerState::Succeeded,
        "canceled" => RemoteRunnerState::Canceled,
        "rolled_back" => RemoteRunnerState::RolledBack,
        "failed" => RemoteRunnerState::Failed,
        "state_unknown" => RemoteRunnerState::StateUnknown,
        _ => return Err(RunnerFailure::ambiguous("Remote runner state is unknown")),
    };
    let step = parse_step(&take_exact(&mut fields, "step")?)?;
    let side_effects_started = match take_exact(&mut fields, "sideEffectsStarted")?.as_str() {
        "0" => false,
        "1" => true,
        _ => {
            return Err(RunnerFailure::ambiguous(
                "Remote side-effect state is invalid",
            ))
        }
    };
    let active_release_id = optional_id(take_exact(&mut fields, "activeReleaseId")?)?;
    let rollback_release_id = optional_id(take_exact(&mut fields, "rollbackReleaseId")?)?;
    let failure_category = parse_failure_category(&take_exact(&mut fields, "failureCategory")?)?;
    let sequence = take_exact(&mut fields, "sequence")?
        .parse::<u32>()
        .ok()
        .filter(|value| *value <= 100_000)
        .ok_or_else(|| RunnerFailure::ambiguous("Remote status sequence is invalid"))?;
    let summary = take_exact(&mut fields, "summary")?;
    if summary.is_empty()
        || summary.len() > 256
        || summary.chars().any(char::is_control)
        || !fields.is_empty()
    {
        return Err(RunnerFailure::ambiguous(
            "Remote status contains unknown or unsafe fields",
        ));
    }
    Ok(RemoteRunnerStatus {
        state,
        step,
        side_effects_started,
        active_release_id,
        rollback_release_id,
        failure_category,
        sequence,
        summary,
    })
}

fn parse_remote_event(
    bytes: &[u8],
    expected_sequence: u32,
) -> Result<RemoteRunnerEvent, RunnerFailure> {
    let mut fields = parse_key_value_document(bytes)?;
    if take_exact(&mut fields, "schemaVersion")? != "1" {
        return Err(RunnerFailure::ambiguous(
            "Remote event schema is unsupported",
        ));
    }
    let sequence = take_exact(&mut fields, "sequence")?
        .parse::<u32>()
        .map_err(|_| RunnerFailure::ambiguous("Remote event sequence is invalid"))?;
    if sequence != expected_sequence {
        return Err(RunnerFailure::ambiguous(
            "Remote event sequence does not match its file",
        ));
    }
    let phase = match take_exact(&mut fields, "phase")?.as_str() {
        "intent" => RemoteEventPhase::Intent,
        "outcome" => RemoteEventPhase::Outcome,
        _ => return Err(RunnerFailure::ambiguous("Remote event phase is unknown")),
    };
    let action = parse_step(&take_exact(&mut fields, "action")?)?;
    let outcome = take_exact(&mut fields, "outcome")?;
    if !matches!(
        outcome.as_str(),
        "pending" | "succeeded" | "failed" | "canceled"
    ) {
        return Err(RunnerFailure::ambiguous("Remote event outcome is unknown"));
    }
    let summary = take_exact(&mut fields, "summary")?;
    if summary.is_empty()
        || summary.len() > 256
        || summary.chars().any(char::is_control)
        || !fields.is_empty()
    {
        return Err(RunnerFailure::ambiguous(
            "Remote event contains unsafe fields",
        ));
    }
    Ok(RemoteRunnerEvent {
        sequence,
        phase,
        action,
        outcome,
        summary,
    })
}

struct NativeRemoteRunnerHost {
    connection: RemoteConnectionRequest,
    known_hosts_path: PathBuf,
}

impl NativeRemoteRunnerHost {
    fn connect(&self) -> Result<crate::execution::SshExecutionSession, RunnerFailure> {
        open_ssh_execution_session(&self.connection, &self.known_hosts_path).map_err(|error| {
            let category = if error.category == ExecutionErrorCategory::HostKeyRejected {
                DeploymentRemoteRunnerFailureCategory::TargetChanged
            } else {
                DeploymentRemoteRunnerFailureCategory::StateUnknown
            };
            RunnerFailure {
                category,
                message: "Reviewed SSH connection for the remote runner failed".into(),
                ambiguous: category == DeploymentRemoteRunnerFailureCategory::StateUnknown,
            }
        })
    }

    fn missing(error: &ssh2::Error) -> bool {
        error.code() == ErrorCode::SFTP(LIBSSH2_FX_NO_SUCH_FILE)
    }

    fn entry(stat: FileStat) -> FileType {
        stat.file_type()
    }

    fn canonical_root(&self, sftp: &Sftp, requested: &str) -> Result<String, RunnerFailure> {
        let canonical = sftp.realpath(Path::new(requested)).map_err(|_| {
            RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::StagingInvalid,
                "Approved remote root could not be canonicalized",
            )
        })?;
        let canonical = canonical.to_str().ok_or_else(|| {
            RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::StagingInvalid,
                "Canonical remote root is not UTF-8",
            )
        })?;
        if canonical != requested {
            return Err(RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::StagingInvalid,
                "Approved remote root no longer has its canonical identity",
            ));
        }
        let stat = sftp.lstat(Path::new(canonical)).map_err(|_| {
            RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::StagingInvalid,
                "Approved remote root is unavailable",
            )
        })?;
        if Self::entry(stat) != FileType::Directory {
            return Err(RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::StagingInvalid,
                "Approved remote root is not a directory",
            ));
        }
        Ok(canonical.to_string())
    }

    fn join(base: &str, component: &str) -> Result<String, RunnerFailure> {
        if component.is_empty()
            || matches!(component, "." | "..")
            || component.contains('/')
            || component.contains('\\')
            || component.chars().any(char::is_control)
        {
            return Err(RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::StagingInvalid,
                "Runtime-owned remote path component is invalid",
            ));
        }
        Ok(format!("{base}/{component}"))
    }

    fn ensure_directory(sftp: &Sftp, path: &str) -> Result<(), RunnerFailure> {
        match sftp.lstat(Path::new(path)) {
            Ok(stat) if stat.file_type() == FileType::Directory => {}
            Ok(_) => {
                return Err(RunnerFailure::definite(
                    DeploymentRemoteRunnerFailureCategory::StagingInvalid,
                    "Runtime-owned remote path is not a directory",
                ))
            }
            Err(error) if Self::missing(&error) => {
                sftp.mkdir(Path::new(path), 0o700).map_err(|_| {
                    RunnerFailure::ambiguous("Runtime-owned remote directory could not be created")
                })?;
            }
            Err(_) => {
                return Err(RunnerFailure::ambiguous(
                    "Runtime-owned remote directory could not be inspected",
                ))
            }
        }
        let canonical = sftp.realpath(Path::new(path)).map_err(|_| {
            RunnerFailure::ambiguous("Runtime-owned remote directory could not be canonicalized")
        })?;
        if canonical.to_str() != Some(path) {
            return Err(RunnerFailure::definite(
                DeploymentRemoteRunnerFailureCategory::StagingInvalid,
                "Runtime-owned remote directory escaped its canonical identity",
            ));
        }
        Ok(())
    }

    fn read_file(sftp: &Sftp, path: &str, limit: usize) -> Result<Option<Vec<u8>>, RunnerFailure> {
        let stat = match sftp.lstat(Path::new(path)) {
            Ok(stat) => stat,
            Err(error) if Self::missing(&error) => return Ok(None),
            Err(_) => {
                return Err(RunnerFailure::ambiguous(
                    "Remote runner file could not be inspected",
                ))
            }
        };
        if stat.file_type() != FileType::RegularFile || stat.size.unwrap_or(u64::MAX) > limit as u64
        {
            return Err(RunnerFailure::ambiguous(
                "Remote runner file type or size is invalid",
            ));
        }
        let file = sftp
            .open(Path::new(path))
            .map_err(|_| RunnerFailure::ambiguous("Remote runner file could not be opened"))?;
        let mut bytes = Vec::new();
        file.take((limit + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| RunnerFailure::ambiguous("Remote runner file could not be read"))?;
        if bytes.len() > limit {
            return Err(RunnerFailure::ambiguous(
                "Remote runner file exceeded its limit",
            ));
        }
        Ok(Some(bytes))
    }

    fn write_immutable(
        sftp: &Sftp,
        path: &str,
        bytes: &[u8],
        mode: i32,
        operation_id: &str,
    ) -> Result<(), RunnerFailure> {
        if let Some(existing) = Self::read_file(sftp, path, MAX_REMOTE_FILE_BYTES)? {
            return if existing == bytes {
                Ok(())
            } else {
                Err(RunnerFailure::definite(
                    DeploymentRemoteRunnerFailureCategory::StagingInvalid,
                    "Immutable remote runner file conflicts with the approved content",
                ))
            };
        }
        let temporary = format!("{path}.{}.part", operation_id.replace(':', "-"));
        let _ = sftp.unlink(Path::new(&temporary));
        let mut file = sftp
            .open_mode(
                Path::new(&temporary),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUSIVE,
                mode,
                OpenType::File,
            )
            .map_err(|_| {
                RunnerFailure::ambiguous("Remote runner temporary file could not be created")
            })?;
        file.write_all(bytes)
            .map_err(|_| RunnerFailure::ambiguous("Remote runner file could not be written"))?;
        file.fsync()
            .map_err(|_| RunnerFailure::ambiguous("Remote runner file could not be synced"))?;
        file.close()
            .map_err(|_| RunnerFailure::ambiguous("Remote runner file could not be closed"))?;
        if let Err(_error) = sftp.rename(
            Path::new(&temporary),
            Path::new(path),
            Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
        ) {
            let _ = sftp.unlink(Path::new(&temporary));
            if Self::read_file(sftp, path, MAX_REMOTE_FILE_BYTES)?.as_deref() == Some(bytes) {
                return Ok(());
            }
            return Err(RunnerFailure::ambiguous(
                "Remote runner file could not be atomically published",
            ));
        }
        Ok(())
    }

    fn paths(
        &self,
        sftp: &Sftp,
        launch: &RunnerLaunch,
    ) -> Result<(String, String, String, String), RunnerFailure> {
        let root = self.canonical_root(sftp, &launch.remote_root)?;
        let shellspan = Self::join(&root, ".shellspan")?;
        Self::ensure_directory(sftp, &shellspan)?;
        let runtime = Self::join(&shellspan, "runtime")?;
        Self::ensure_directory(sftp, &runtime)?;
        let runs = Self::join(&shellspan, "runs")?;
        Self::ensure_directory(sftp, &runs)?;
        let run = Self::join(&runs, &launch.run_id)?;
        Self::ensure_directory(sftp, &run)?;
        let events = Self::join(&run, "events")?;
        Self::ensure_directory(sftp, &events)?;
        Ok((root, runtime, run, events))
    }

    fn launch_command(runner: &str, request: &str, run: &str, sha256: &str) -> String {
        let script = r#"runner=$1
request=$2
run_dir=$3
expected=$4
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$runner" | awk '{print $1}'); else actual=$(shasum -a 256 "$runner" | awk '{print $1}'); fi
[ "$actual" = "$expected" ] || exit 70
umask 077
accepted="$run_dir/launch.accepted"
tmp="$accepted.$$"
printf '%s\n' "$expected" > "$tmp" || exit 71
mv -f "$tmp" "$accepted" || exit 71
nohup sh "$runner" "$request" "$run_dir" </dev/null >/dev/null 2>&1 &
printf 'STARTED\n'"#;
        format!(
            "sh -c {} shellspan-deployment-launch {} {} {} {}",
            posix_quote(script),
            posix_quote(runner),
            posix_quote(request),
            posix_quote(run),
            posix_quote(sha256),
        )
    }
}

fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

impl RemoteRunnerHost for NativeRemoteRunnerHost {
    fn install_and_start(&mut self, launch: &RunnerLaunch) -> Result<(), RunnerFailure> {
        let session = self.connect()?;
        let sftp = session.target.sftp().map_err(|_| {
            RunnerFailure::ambiguous("Reviewed SFTP session for the remote runner failed")
        })?;
        let (_root, runtime, run, _events) = self.paths(&sftp, launch)?;
        let runner_path = Self::join(&runtime, &format!("runner-v1-{}.sh", launch.runner_sha256))?;
        let request_path = Self::join(&run, "request.v1.tsv")?;
        Self::write_immutable(
            &sftp,
            &runner_path,
            REMOTE_RUNNER_SCRIPT.as_bytes(),
            0o700,
            &launch.operation_id,
        )?;
        Self::write_immutable(
            &sftp,
            &request_path,
            &launch.request_bytes,
            0o600,
            &launch.operation_id,
        )?;
        let command =
            Self::launch_command(&runner_path, &request_path, &run, &launch.runner_sha256);
        let launch_result = (|| {
            let mut channel = session.target.channel_session().map_err(|_| ())?;
            start_ssh_exec_channel(&mut channel, &command).map_err(|_| ())?;
            let mut output = Vec::new();
            (&mut channel)
                .take(64)
                .read_to_end(&mut output)
                .map_err(|_| ())?;
            channel.wait_close().map_err(|_| ())?;
            if channel.exit_status().ok() == Some(0) && output == b"STARTED\n" {
                Ok(())
            } else {
                Err(())
            }
        })();
        if launch_result.is_err() {
            // The launch channel can disappear after the detached process was
            // accepted. Reconnect once and trust only the atomic marker whose
            // content is the compiled-in runner digest.
            drop(sftp);
            drop(session);
            let recovery = self.connect()?;
            let recovery_sftp = recovery.target.sftp().map_err(|_| {
                RunnerFailure::ambiguous("Remote runner launch state could not be reconciled")
            })?;
            let (_root, _runtime, recovery_run, _events) = self.paths(&recovery_sftp, launch)?;
            let accepted = Self::join(&recovery_run, "launch.accepted")?;
            if Self::read_file(&recovery_sftp, &accepted, 128)?.as_deref()
                != Some(format!("{}\n", launch.runner_sha256).as_bytes())
            {
                return Err(RunnerFailure::ambiguous(
                    "Remote runner launch acceptance could not be proved",
                ));
            }
        }
        Ok(())
    }

    fn observe(
        &mut self,
        launch: &RunnerLaunch,
        after_sequence: u32,
    ) -> Result<RemoteObservation, RunnerFailure> {
        let session = self.connect()?;
        let sftp = session
            .target
            .sftp()
            .map_err(|_| RunnerFailure::ambiguous("Reviewed SFTP observation session failed"))?;
        let (_root, _runtime, run, events_path) = self.paths(&sftp, launch)?;
        let status_path = Self::join(&run, "status.v1")?;
        let status = Self::read_file(&sftp, &status_path, 4 * 1024)?
            .map(|bytes| parse_remote_status(&bytes))
            .transpose()?;
        let last_sequence = status
            .as_ref()
            .map(|status| status.sequence)
            .unwrap_or(after_sequence);
        if last_sequence < after_sequence || last_sequence.saturating_sub(after_sequence) > 1_000 {
            return Err(RunnerFailure::ambiguous(
                "Remote runner event window is invalid",
            ));
        }
        let mut events = Vec::new();
        for sequence in after_sequence.saturating_add(1)..=last_sequence {
            let path = Self::join(&events_path, &format!("{sequence:06}.event"))?;
            let bytes = Self::read_file(&sftp, &path, 4 * 1024)?
                .ok_or_else(|| RunnerFailure::ambiguous("Remote runner event ledger has a gap"))?;
            events.push(parse_remote_event(&bytes, sequence)?);
        }
        Ok(RemoteObservation { status, events })
    }

    fn request_cancel(&mut self, launch: &RunnerLaunch) -> Result<(), RunnerFailure> {
        let session = self.connect()?;
        let sftp = session
            .target
            .sftp()
            .map_err(|_| RunnerFailure::ambiguous("Reviewed SFTP cancellation session failed"))?;
        let (_root, _runtime, run, _events) = self.paths(&sftp, launch)?;
        let path = Self::join(&run, "cancel.requested")?;
        let bytes = format!(
            "schemaVersion=1\noperationId={}\nplanDigest={}\n",
            launch.operation_id, launch.plan_digest
        );
        Self::write_immutable(&sftp, &path, bytes.as_bytes(), 0o600, &launch.operation_id)
    }
}

pub(crate) fn run_deployment_remote_runner(
    database: &Database,
    credentials: &CredentialManager,
    cancellations: &ExecutionCancellationRegistry,
    known_hosts_path: &Path,
    artifact_staging_root: &Path,
    request: DeploymentRemoteRunnerRequest,
    emit: &mut dyn FnMut(DeploymentRemoteRunnerProgress),
) -> DeploymentRemoteRunnerResult {
    if let Err(failure) = validate_request(&request) {
        return failure_result(&request, failure.category, failure.ambiguous);
    }
    let workflow = match database.get_deployment_workflow(&request.workflow_id) {
        Ok(Some(workflow)) => workflow,
        _ => {
            return failure_result(
                &request,
                DeploymentRemoteRunnerFailureCategory::WorkflowChanged,
                false,
            )
        }
    };
    let profile = match database.get_profile(&workflow.connection_profile_id) {
        Ok(Some(profile)) => profile,
        _ => {
            return failure_result(
                &request,
                DeploymentRemoteRunnerFailureCategory::TargetChanged,
                false,
            )
        }
    };
    let connection = match connection_for_profile(credentials, &profile) {
        Ok(connection) => connection,
        Err(_) => {
            return failure_result(
                &request,
                DeploymentRemoteRunnerFailureCategory::TargetChanged,
                false,
            )
        }
    };
    let mut host = NativeRemoteRunnerHost {
        connection,
        known_hosts_path: known_hosts_path.to_path_buf(),
    };
    run_with_host(
        database,
        artifact_staging_root,
        cancellations,
        request,
        &mut host,
        emit,
    )
}

#[derive(Debug, Clone)]
struct ReconciliationSnapshot {
    run_directory_present: bool,
    launch_accepted: bool,
    runner_identity_verified: bool,
    request_identity_verified: bool,
    observation: RemoteObservation,
    current_release_id: Option<String>,
    previous_release_id: Option<String>,
    target_release_verified: bool,
    rollback_release_verified: bool,
    compose_services_verified: bool,
    health_verified: bool,
}

fn empty_reconciliation_evidence() -> DeploymentReconciliationEvidence {
    DeploymentReconciliationEvidence {
        remote_sequence: None,
        runner_identity_verified: false,
        request_identity_verified: false,
        ledger_verified: false,
        current_release_id: None,
        previous_release_id: None,
        target_release_verified: false,
        rollback_release_verified: false,
        compose_services_verified: false,
        health_verified: false,
        side_effects_started: None,
        approval_reusable: false,
    }
}

fn recovery_candidate(
    database: &Database,
    run: &super::DeploymentRunRecord,
) -> Result<(DeploymentStartupRecoveryCandidate, Option<String>), String> {
    let (status, operation_id) = if run.status == DeploymentRunStatus::Reconciling {
        let event = database
            .list_deployment_run_events(&run.id, run.last_event_sequence.saturating_sub(1), 1)?
            .into_iter()
            .next()
            .filter(|event| event.event_kind == DeploymentEventKind::ReconciliationStarted)
            .ok_or_else(|| "DEPLOYMENT_RECONCILIATION_LEDGER_INVALID".to_string())?;
        let payload = event
            .payload
            .ok_or_else(|| "DEPLOYMENT_RECONCILIATION_LEDGER_INVALID".to_string())?;
        let status = payload
            .get("previousStatus")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| {
                serde_json::from_value::<DeploymentRunStatus>(serde_json::Value::String(
                    value.to_string(),
                ))
                .ok()
            })
            .filter(|status| {
                matches!(
                    status,
                    DeploymentRunStatus::InProgress
                        | DeploymentRunStatus::Verifying
                        | DeploymentRunStatus::CancelRequested
                        | DeploymentRunStatus::StateUnknown
                )
            })
            .ok_or_else(|| "DEPLOYMENT_RECONCILIATION_LEDGER_INVALID".to_string())?;
        let operation_id = payload
            .get("request")
            .and_then(|value| value.get("operationId"))
            .and_then(serde_json::Value::as_str)
            .filter(|value| {
                value.starts_with(RECONCILIATION_OPERATION_PREFIX)
                    && crate::execution::valid_operation_id(value)
            })
            .map(str::to_string)
            .ok_or_else(|| "DEPLOYMENT_RECONCILIATION_LEDGER_INVALID".to_string())?;
        (status, Some(operation_id))
    } else {
        (run.status, None)
    };
    Ok((
        DeploymentStartupRecoveryCandidate {
            run_id: run.id.clone(),
            plan_id: format!("plan-{}", run.approval_digest),
            plan_digest: run.approval_digest.clone(),
            status,
            last_event_sequence: run.last_event_sequence,
            reconciliation_required: true,
        },
        operation_id,
    ))
}

pub(crate) fn list_deployment_startup_recovery(
    database: &Database,
) -> Result<DeploymentStartupRecoveryResult, String> {
    let candidates = database
        .list_deployment_startup_recovery_runs(100)?
        .iter()
        .map(|run| recovery_candidate(database, run).map(|value| value.0))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(DeploymentStartupRecoveryResult {
        schema_version: 1,
        candidates,
    })
}

pub(crate) fn get_deployment_reconciliation_binding(
    database: &Database,
    run_id: &str,
) -> Result<DeploymentReconciliationBinding, String> {
    let run = database
        .get_deployment_run(run_id)?
        .ok_or_else(|| "DEPLOYMENT_RUN_NOT_FOUND".to_string())?;
    if !matches!(
        run.status,
        DeploymentRunStatus::Reconciling
            | DeploymentRunStatus::InProgress
            | DeploymentRunStatus::Verifying
            | DeploymentRunStatus::CancelRequested
            | DeploymentRunStatus::StateUnknown
    ) {
        return Err("DEPLOYMENT_RECONCILIATION_NOT_REQUIRED".into());
    }
    let interrupted_request = if run.status == DeploymentRunStatus::Reconciling {
        database
            .list_deployment_run_events(&run.id, run.last_event_sequence.saturating_sub(1), 1)?
            .into_iter()
            .next()
            .and_then(|event| event.payload)
            .and_then(|payload| payload.get("request").cloned())
            .map(serde_json::from_value::<DeploymentReconciliationRequest>)
            .transpose()
            .map_err(|_| "DEPLOYMENT_RECONCILIATION_LEDGER_INVALID".to_string())?
    } else {
        None
    };
    let receipt = match interrupted_request.as_ref() {
        Some(interrupted) => {
            database.get_deployment_transfer_receipt(&interrupted.artifact_transfer_operation_id)?
        }
        None => database.get_latest_deployment_transfer_receipt_for_run(run_id)?,
    }
    .ok_or_else(|| "DEPLOYMENT_TRANSFER_RECEIPT_NOT_FOUND".to_string())?;
    let staging_identity = interrupted_request
        .as_ref()
        .map(|request| request.remote_staging_identity.clone())
        .or_else(|| receipt.result.remote_staging_identity.clone())
        .ok_or_else(|| "DEPLOYMENT_TRANSFER_RECEIPT_INVALID".to_string())?;
    if receipt.plan_id != format!("plan-{}", run.approval_digest)
        || receipt.plan_digest != run.approval_digest
        || receipt.result.remote_staging_identity.as_deref() != Some(&staging_identity)
    {
        return Err("DEPLOYMENT_TRANSFER_RECEIPT_MISMATCH".into());
    }
    let (candidate, reconciliation_operation_id) = recovery_candidate(database, &run)?;
    Ok(DeploymentReconciliationBinding {
        candidate,
        artifact_transfer_operation_id: receipt.operation_id,
        remote_staging_identity: staging_identity,
        reconciliation_operation_id,
    })
}

fn validate_reconciliation_request(
    request: &DeploymentReconciliationRequest,
) -> Result<(), String> {
    if !request
        .operation_id
        .starts_with(RECONCILIATION_OPERATION_PREFIX)
        || !crate::execution::valid_operation_id(&request.operation_id)
        || request.expected_run_revision == 0
        || request.plan_id != format!("plan-{}", request.plan_digest)
        || super::validate_sha256(&request.plan_digest).is_err()
        || !super::artifact_transfer::valid_artifact_transfer_operation_id(
            &request.artifact_transfer_operation_id,
        )
        || parse_staging_identity(&request.remote_staging_identity).is_err()
    {
        return Err("DEPLOYMENT_RECONCILIATION_REQUEST_INVALID".into());
    }
    super::validate_identifier("deployment run id", &request.run_id, 128)
        .map_err(|_| "DEPLOYMENT_RECONCILIATION_REQUEST_INVALID".to_string())
}

fn reconciliation_request_payload(request: &DeploymentReconciliationRequest) -> serde_json::Value {
    serde_json::json!({
        "operationId": request.operation_id,
        "planId": request.plan_id,
        "planDigest": request.plan_digest,
        "runId": request.run_id,
        "expectedRunRevision": request.expected_run_revision,
        "artifactTransferOperationId": request.artifact_transfer_operation_id,
        "remoteStagingIdentity": request.remote_staging_identity,
    })
}

fn completed_reconciliation_result(
    database: &Database,
    request: &DeploymentReconciliationRequest,
) -> Result<Option<DeploymentReconciliationResult>, String> {
    let events = database.list_deployment_run_events(&request.run_id, 0, 500)?;
    let Some(event) = events.last() else {
        return Ok(None);
    };
    if event.event_kind != DeploymentEventKind::ReconciliationCompleted {
        return Ok(None);
    }
    let Some(payload) = event.payload.as_ref() else {
        return Ok(None);
    };
    if payload.get("request") != Some(&reconciliation_request_payload(request)) {
        return Ok(None);
    }
    payload
        .get("result")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| "stored deployment reconciliation result is invalid".to_string())
}

fn begin_reconciliation(
    database: &Database,
    request: &DeploymentReconciliationRequest,
) -> Result<(super::DeploymentRunRecord, bool), String> {
    validate_reconciliation_request(request)?;
    if completed_reconciliation_result(database, request)?.is_some() {
        return Err("DEPLOYMENT_RECONCILIATION_ALREADY_COMPLETED".into());
    }
    let run = database
        .get_deployment_run(&request.run_id)?
        .ok_or_else(|| "DEPLOYMENT_RUN_NOT_FOUND".to_string())?;
    if run.approval_digest != request.plan_digest
        || request.plan_id != format!("plan-{}", run.approval_digest)
        || run.last_event_sequence != request.expected_run_revision
    {
        return Err("REVISION_CONFLICT".into());
    }
    if run.status == DeploymentRunStatus::Reconciling {
        let event = database
            .list_deployment_run_events(&run.id, run.last_event_sequence.saturating_sub(1), 1)?
            .into_iter()
            .next()
            .filter(|event| event.event_kind == DeploymentEventKind::ReconciliationStarted)
            .ok_or_else(|| "DEPLOYMENT_RECONCILIATION_LEDGER_INVALID".to_string())?;
        let payload = event
            .payload
            .ok_or_else(|| "DEPLOYMENT_RECONCILIATION_LEDGER_INVALID".to_string())?;
        let stored = payload
            .get("request")
            .cloned()
            .ok_or_else(|| "DEPLOYMENT_RECONCILIATION_LEDGER_INVALID".to_string())?;
        let stored: DeploymentReconciliationRequest = serde_json::from_value(stored)
            .map_err(|_| "DEPLOYMENT_RECONCILIATION_LEDGER_INVALID".to_string())?;
        if stored.operation_id != request.operation_id
            || stored.plan_id != request.plan_id
            || stored.plan_digest != request.plan_digest
            || stored.run_id != request.run_id
            || stored.artifact_transfer_operation_id != request.artifact_transfer_operation_id
            || stored.remote_staging_identity != request.remote_staging_identity
        {
            return Err("REVISION_CONFLICT".into());
        }
        let previous_status = payload
            .get("previousStatus")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| {
                serde_json::from_value::<DeploymentRunStatus>(serde_json::Value::String(
                    value.to_string(),
                ))
                .ok()
            })
            .filter(|status| {
                matches!(
                    status,
                    DeploymentRunStatus::InProgress
                        | DeploymentRunStatus::Verifying
                        | DeploymentRunStatus::CancelRequested
                        | DeploymentRunStatus::StateUnknown
                )
            })
            .ok_or_else(|| "DEPLOYMENT_RECONCILIATION_LEDGER_INVALID".to_string())?;
        let cancel_intent = previous_status == DeploymentRunStatus::CancelRequested
            || database
                .list_deployment_run_events(&run.id, 0, 500)?
                .iter()
                .any(|event| event.event_kind == DeploymentEventKind::CancellationRequested);
        let mut original = run;
        original.status = previous_status;
        return Ok((original, cancel_intent));
    }
    if !matches!(
        run.status,
        DeploymentRunStatus::InProgress
            | DeploymentRunStatus::Verifying
            | DeploymentRunStatus::CancelRequested
            | DeploymentRunStatus::StateUnknown
    ) {
        return Err("REVISION_CONFLICT".into());
    }
    let receipt = database
        .get_deployment_transfer_receipt(&request.artifact_transfer_operation_id)?
        .ok_or_else(|| "DEPLOYMENT_TRANSFER_RECEIPT_NOT_FOUND".to_string())?;
    if receipt.run_id != run.id
        || receipt.plan_id != request.plan_id
        || receipt.plan_digest != request.plan_digest
        || receipt.result.status
            != super::artifact_transfer::DeploymentArtifactTransferStatus::Succeeded
        || receipt.result.remote_staging_identity.as_deref()
            != Some(&request.remote_staging_identity)
    {
        return Err("DEPLOYMENT_TRANSFER_RECEIPT_MISMATCH".into());
    }
    let cancel_intent = run.status == DeploymentRunStatus::CancelRequested
        || database
            .list_deployment_run_events(&run.id, 0, 500)?
            .iter()
            .any(|event| event.event_kind == DeploymentEventKind::CancellationRequested);
    database.transition_deployment_run_atomic(
        &run.id,
        request.expected_run_revision,
        run.status,
        DeploymentRunStatus::Reconciling,
        &DeploymentEventWrite {
            event_kind: DeploymentEventKind::ReconciliationStarted,
            status: Some(DeploymentRunStatus::Reconciling),
            summary: "Read-only deployment reconciliation started".into(),
            payload: Some(serde_json::json!({
                "request": reconciliation_request_payload(request),
                "previousStatus": run.status.as_str(),
            })),
        },
    )?;
    Ok((run, cancel_intent))
}

fn parse_remote_request_identity(bytes: &[u8]) -> Result<(String, String), RunnerFailure> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| RunnerFailure::ambiguous("Remote runner request is not UTF-8"))?;
    let (digest_line, body) = text
        .split_once('\n')
        .ok_or_else(|| RunnerFailure::ambiguous("Remote runner request is truncated"))?;
    let expected_digest = digest_line
        .strip_prefix("request_digest\t")
        .ok_or_else(|| RunnerFailure::ambiguous("Remote runner request digest is missing"))?;
    if super::validate_sha256(expected_digest).is_err()
        || sha256_bytes(body.as_bytes()) != expected_digest
    {
        return Err(RunnerFailure::ambiguous(
            "Remote runner request digest does not match",
        ));
    }
    let mut operation_id = None;
    let mut runner_sha256 = None;
    let mut seen = std::collections::BTreeSet::new();
    for line in body.lines() {
        let (key, value) = line
            .split_once('\t')
            .ok_or_else(|| RunnerFailure::ambiguous("Remote runner request is malformed"))?;
        if key.is_empty() || value.contains('\t') || !seen.insert(key) {
            return Err(RunnerFailure::ambiguous(
                "Remote runner request contains duplicate or unsafe fields",
            ));
        }
        match key {
            "operation_id" => operation_id = Some(value.to_string()),
            "runner_sha256" => runner_sha256 = Some(value.to_string()),
            _ => {}
        }
    }
    let operation_id = operation_id
        .filter(|value| valid_remote_runner_operation_id(value))
        .ok_or_else(|| RunnerFailure::ambiguous("Remote runner operation identity is invalid"))?;
    let runner_sha256 = runner_sha256
        .filter(|value| super::validate_sha256(value).is_ok())
        .ok_or_else(|| RunnerFailure::ambiguous("Remote runner SHA-256 is invalid"))?;
    Ok((operation_id, runner_sha256))
}

fn ensure_read_only_directory(sftp: &Sftp, path: &str) -> Result<bool, RunnerFailure> {
    let stat = match sftp.lstat(Path::new(path)) {
        Ok(stat) => stat,
        Err(error) if NativeRemoteRunnerHost::missing(&error) => return Ok(false),
        Err(_) => {
            return Err(RunnerFailure::ambiguous(
                "Remote reconciliation directory could not be inspected",
            ))
        }
    };
    if stat.file_type() != FileType::Directory {
        return Err(RunnerFailure::ambiguous(
            "Remote reconciliation directory identity is invalid",
        ));
    }
    let canonical = sftp
        .realpath(Path::new(path))
        .map_err(|_| RunnerFailure::ambiguous("Remote reconciliation path is unavailable"))?;
    if canonical.to_str() != Some(path) {
        return Err(RunnerFailure::ambiguous(
            "Remote reconciliation path escaped its fixed identity",
        ));
    }
    Ok(true)
}

fn read_release_link(sftp: &Sftp, path: &str) -> Result<Option<String>, RunnerFailure> {
    let stat = match sftp.lstat(Path::new(path)) {
        Ok(stat) => stat,
        Err(error) if NativeRemoteRunnerHost::missing(&error) => return Ok(None),
        Err(_) => {
            return Err(RunnerFailure::ambiguous(
                "Release link could not be inspected",
            ))
        }
    };
    if stat.file_type() != FileType::Symlink {
        return Err(RunnerFailure::ambiguous("Release link identity is invalid"));
    }
    let target = sftp
        .readlink(Path::new(path))
        .map_err(|_| RunnerFailure::ambiguous("Release link target could not be read"))?;
    let target = target
        .to_str()
        .and_then(|value| value.strip_prefix("releases/"))
        .ok_or_else(|| RunnerFailure::ambiguous("Release link target is unsafe"))?;
    super::validate_identifier("release id", target, 128)
        .map_err(|_| RunnerFailure::ambiguous("Release link target is invalid"))?;
    Ok(Some(target.to_string()))
}

fn read_release_digest(
    sftp: &Sftp,
    remote_root: &str,
    release_id: &str,
) -> Result<Option<String>, RunnerFailure> {
    let releases = NativeRemoteRunnerHost::join(remote_root, "releases")?;
    let release = NativeRemoteRunnerHost::join(&releases, release_id)?;
    if !ensure_read_only_directory(sftp, &release)? {
        return Ok(None);
    }
    let digest_path = NativeRemoteRunnerHost::join(&release, ".shellspan-artifact-sha256")?;
    let Some(bytes) = NativeRemoteRunnerHost::read_file(sftp, &digest_path, 128)? else {
        return Ok(None);
    };
    let digest = std::str::from_utf8(&bytes)
        .ok()
        .map(str::trim)
        .filter(|value| super::validate_sha256(value).is_ok())
        .ok_or_else(|| RunnerFailure::ambiguous("Release digest evidence is invalid"))?;
    Ok(Some(digest.to_string()))
}

fn read_service_scope(
    sftp: &Sftp,
    remote_root: &str,
    release_id: &str,
    approved: &[String],
) -> Result<Vec<String>, RunnerFailure> {
    let mut services = if approved.is_empty() {
        let releases = NativeRemoteRunnerHost::join(remote_root, "releases")?;
        let release = NativeRemoteRunnerHost::join(&releases, release_id)?;
        let path = NativeRemoteRunnerHost::join(&release, ".shellspan.services")?;
        let bytes = NativeRemoteRunnerHost::read_file(sftp, &path, 16 * 1024)?
            .ok_or_else(|| RunnerFailure::ambiguous("Runtime service scope is missing"))?;
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| RunnerFailure::ambiguous("Runtime service scope is not UTF-8"))?;
        text.lines().map(str::to_string).collect::<Vec<_>>()
    } else {
        approved.to_vec()
    };
    if services.is_empty() || services.len() > 64 {
        return Err(RunnerFailure::ambiguous("Runtime service scope is invalid"));
    }
    let mut unique = std::collections::BTreeSet::new();
    for service in &services {
        super::validate_identifier("compose service", service, 128)
            .map_err(|_| RunnerFailure::ambiguous("Runtime service identity is invalid"))?;
        if !unique.insert(service.clone()) {
            return Err(RunnerFailure::ambiguous(
                "Runtime service scope contains duplicates",
            ));
        }
    }
    services.sort();
    Ok(services)
}

fn compose_probe_command(
    compose_project: &str,
    expected_image_reference: &str,
    expected_image_id: Option<&str>,
    health_path: Option<&str>,
    services: &[String],
) -> String {
    let script = r#"project=$1
expected_reference=$2
expected_image=$3
health_path=$4
shift 4
[ -n "$expected_image" ] || expected_image=$(docker image inspect --format '{{.Id}}' "$expected_reference" 2>/dev/null) || exit 69
printf 'schemaVersion=1\n'
printf 'serviceCount=%s\n' "$#"
for service do
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service" 2>/dev/null) || exit 70
  count=$(printf '%s\n' "$ids" | sed '/^$/d' | wc -l | tr -d ' ')
  [ "$count" = 1 ] || exit 71
  id=$(printf '%s\n' "$ids" | sed -n '1p')
  observed=$(docker inspect --format '{{.Config.Image}}|{{.Image}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null) || exit 72
  observed_reference=${observed%%|*}
  observed_tail=${observed#*|}
  observed_image=${observed_tail%%|*}
  [ "$observed_reference" = "$expected_reference" ] && [ "$observed_image" = "$expected_image" ] || exit 74
  printf 'service\t%s\t%s\n' "$service" "$observed"
done
if [ -n "$health_path" ]; then
  status=$(curl --silent --show-error --output /dev/null --max-time 5 --write-out '%{http_code}' "http://127.0.0.1$health_path" 2>/dev/null) || exit 73
else
  status=0
fi
printf 'httpStatus=%s\nend=1\n' "$status""#;
    let mut command = format!(
        "sh -c {} shellspan-deployment-reconcile {} {} {} {}",
        posix_quote(script),
        posix_quote(compose_project),
        posix_quote(expected_image_reference),
        posix_quote(expected_image_id.unwrap_or("")),
        posix_quote(health_path.unwrap_or("")),
    );
    for service in services {
        command.push(' ');
        command.push_str(&posix_quote(service));
    }
    command
}

fn parse_compose_probe(
    output: &str,
    services: &[String],
    expected_image_reference: &str,
    expected_image_id: Option<&str>,
    expected_http_status: Option<u16>,
) -> Result<(bool, bool), RunnerFailure> {
    let mut lines = output.lines();
    if lines.next() != Some("schemaVersion=1")
        || lines.next() != Some(&format!("serviceCount={}", services.len()))
    {
        return Err(RunnerFailure::ambiguous(
            "Compose evidence header is invalid",
        ));
    }
    let mut compose_verified = true;
    for expected_service in services {
        let line = lines
            .next()
            .ok_or_else(|| RunnerFailure::ambiguous("Compose evidence is truncated"))?;
        let fields = line.split('\t').collect::<Vec<_>>();
        if fields.len() != 3 || fields[0] != "service" || fields[1] != expected_service {
            return Err(RunnerFailure::ambiguous(
                "Compose evidence ordering is invalid",
            ));
        }
        let state = fields[2].split('|').collect::<Vec<_>>();
        if state.len() != 4 {
            return Err(RunnerFailure::ambiguous(
                "Compose evidence state is invalid",
            ));
        }
        compose_verified &= state[0] == expected_image_reference
            && expected_image_id.is_none_or(|expected| state[1] == expected)
            && state[2] == "running"
            && matches!(state[3], "healthy" | "none");
    }
    let http_status = lines
        .next()
        .and_then(|line| line.strip_prefix("httpStatus="))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| RunnerFailure::ambiguous("Health evidence is invalid"))?;
    if lines.next() != Some("end=1") || lines.next().is_some() {
        return Err(RunnerFailure::ambiguous(
            "Compose evidence has unknown fields",
        ));
    }
    let health_verified = compose_verified
        && expected_http_status.map_or(http_status == 0, |expected| http_status == expected);
    Ok((compose_verified, health_verified))
}

fn observe_read_only(
    sftp: &Sftp,
    remote_root: &str,
    run_id: &str,
) -> Result<RemoteObservation, RunnerFailure> {
    let shellspan = NativeRemoteRunnerHost::join(remote_root, ".shellspan")?;
    let runs = NativeRemoteRunnerHost::join(&shellspan, "runs")?;
    let run = NativeRemoteRunnerHost::join(&runs, run_id)?;
    let events_path = NativeRemoteRunnerHost::join(&run, "events")?;
    if !ensure_read_only_directory(sftp, &events_path)? {
        return Ok(RemoteObservation {
            status: None,
            events: Vec::new(),
        });
    }
    let mut sequences = Vec::new();
    for (path, stat) in sftp
        .readdir(Path::new(&events_path))
        .map_err(|_| RunnerFailure::ambiguous("Remote event ledger could not be listed"))?
    {
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            return Err(RunnerFailure::ambiguous("Remote event filename is invalid"));
        };
        if name.starts_with('.') {
            continue;
        }
        let Some(number) = name.strip_suffix(".event") else {
            return Err(RunnerFailure::ambiguous(
                "Remote event ledger contains unknown files",
            ));
        };
        if number.len() != 6 || stat.file_type() != FileType::RegularFile {
            return Err(RunnerFailure::ambiguous(
                "Remote event file identity is invalid",
            ));
        }
        sequences.push(
            number
                .parse::<u32>()
                .map_err(|_| RunnerFailure::ambiguous("Remote event filename is invalid"))?,
        );
    }
    sequences.sort_unstable();
    if sequences.len() > 1_000
        || sequences
            .iter()
            .enumerate()
            .any(|(index, value)| *value != u32::try_from(index).unwrap_or(u32::MAX) + 1)
    {
        return Err(RunnerFailure::ambiguous(
            "Remote event ledger is truncated or out of order",
        ));
    }
    let mut events = Vec::with_capacity(sequences.len());
    for sequence in sequences {
        let path = NativeRemoteRunnerHost::join(&events_path, &format!("{sequence:06}.event"))?;
        let bytes = NativeRemoteRunnerHost::read_file(sftp, &path, 4 * 1024)?
            .ok_or_else(|| RunnerFailure::ambiguous("Remote event ledger has a gap"))?;
        events.push(parse_remote_event(&bytes, sequence)?);
    }
    let status_path = NativeRemoteRunnerHost::join(&run, "status.v1")?;
    let status = NativeRemoteRunnerHost::read_file(sftp, &status_path, 4 * 1024)?
        .map(|bytes| parse_remote_status(&bytes))
        .transpose()?;
    if let Some(status) = &status {
        if status.sequence != u32::try_from(events.len()).unwrap_or(u32::MAX) {
            return Err(RunnerFailure::ambiguous(
                "Remote status and event ledger sequences disagree",
            ));
        }
    } else if !events.is_empty() {
        return Err(RunnerFailure::ambiguous(
            "Remote event ledger exists without atomic status",
        ));
    }
    Ok(RemoteObservation { status, events })
}

fn inspect_reconciliation_snapshot(
    host: &mut NativeRemoteRunnerHost,
    request: &DeploymentReconciliationRequest,
    run: &super::DeploymentRunRecord,
    receipt: &super::repository::DeploymentTransferReceiptRecord,
    plan: &super::DeploymentStoredPlanRecord,
    artifact: &VerifiedDeploymentArtifact,
    workflow: &super::DeploymentWorkflowRecord,
    cancellation: &CancellationHandle,
    deadline: Instant,
) -> Result<ReconciliationSnapshot, RunnerFailure> {
    let session = host.connect()?;
    let remaining_ms = deadline
        .saturating_duration_since(Instant::now())
        .as_millis()
        .min(u128::from(u32::MAX)) as u32;
    session.target.set_timeout(remaining_ms.max(1));
    if cancellation.terminal_state() != ExecutionTerminalState::Running {
        return Err(RunnerFailure::ambiguous(
            "Reconciliation observation was stopped",
        ));
    }
    let sftp = session
        .target
        .sftp()
        .map_err(|_| RunnerFailure::ambiguous("Read-only reconciliation SFTP session failed"))?;
    let root = host.canonical_root(&sftp, &plan.approval_summary.remote_root)?;
    let shellspan = NativeRemoteRunnerHost::join(&root, ".shellspan")?;
    if !ensure_read_only_directory(&sftp, &shellspan)? {
        return Ok(ReconciliationSnapshot {
            run_directory_present: false,
            launch_accepted: false,
            runner_identity_verified: false,
            request_identity_verified: false,
            observation: RemoteObservation {
                status: None,
                events: Vec::new(),
            },
            current_release_id: None,
            previous_release_id: None,
            target_release_verified: false,
            rollback_release_verified: false,
            compose_services_verified: false,
            health_verified: false,
        });
    }
    let runs = NativeRemoteRunnerHost::join(&shellspan, "runs")?;
    let run_path = NativeRemoteRunnerHost::join(&runs, &run.id)?;
    if !ensure_read_only_directory(&sftp, &run_path)? {
        return Ok(ReconciliationSnapshot {
            run_directory_present: false,
            launch_accepted: false,
            runner_identity_verified: false,
            request_identity_verified: false,
            observation: RemoteObservation {
                status: None,
                events: Vec::new(),
            },
            current_release_id: None,
            previous_release_id: None,
            target_release_verified: false,
            rollback_release_verified: false,
            compose_services_verified: false,
            health_verified: false,
        });
    }
    let request_path = NativeRemoteRunnerHost::join(&run_path, "request.v1.tsv")?;
    let request_bytes =
        NativeRemoteRunnerHost::read_file(&sftp, &request_path, MAX_REMOTE_FILE_BYTES)?
            .ok_or_else(|| RunnerFailure::ambiguous("Remote runner request is missing"))?;
    let (runner_operation_id, runner_sha256) = parse_remote_request_identity(&request_bytes)?;
    let expected_runner_sha256 = sha256_bytes(REMOTE_RUNNER_SCRIPT.as_bytes());
    if runner_sha256 != expected_runner_sha256 {
        return Err(RunnerFailure::ambiguous(
            "Remote runner SHA-256 identity changed",
        ));
    }
    let expected_runner_request = DeploymentRemoteRunnerRequest {
        operation_id: runner_operation_id,
        plan_id: request.plan_id.clone(),
        plan_digest: request.plan_digest.clone(),
        run_id: request.run_id.clone(),
        run_revision: request.expected_run_revision,
        plan_expires_at: plan.expires_at,
        workflow_id: plan.approval_summary.workflow_id.clone(),
        workflow_revision: plan.approval_summary.workflow_revision,
        artifact_reference: plan
            .approval_summary
            .artifact_reference
            .clone()
            .ok_or_else(|| RunnerFailure::ambiguous("Approved artifact identity is missing"))?,
        artifact_transfer_operation_id: receipt.operation_id.clone(),
        source_revision: plan.approval_summary.frozen.source_revision.clone(),
        target: plan.approval_summary.frozen.target.clone(),
        remote_root: plan.approval_summary.remote_root.clone(),
        release_id: plan
            .approval_summary
            .frozen
            .target_release
            .release_id
            .clone(),
        release_digest_sha256: plan
            .approval_summary
            .frozen
            .target_release
            .artifact_digest_sha256
            .clone(),
        remote_staging_identity: request.remote_staging_identity.clone(),
        timeout_ms: MIN_TIMEOUT_MS,
    };
    let expected_bytes = build_runner_request(
        &expected_runner_request,
        plan,
        artifact,
        workflow,
        &expected_runner_sha256,
    )?;
    if expected_bytes != request_bytes {
        return Err(RunnerFailure::ambiguous(
            "Remote runner request does not match the frozen approved identities",
        ));
    }
    let runtime = NativeRemoteRunnerHost::join(&shellspan, "runtime")?;
    if !ensure_read_only_directory(&sftp, &runtime)? {
        return Err(RunnerFailure::ambiguous(
            "Remote runner runtime directory is missing",
        ));
    }
    let runner_path =
        NativeRemoteRunnerHost::join(&runtime, &format!("runner-v1-{expected_runner_sha256}.sh"))?;
    let runner_bytes =
        NativeRemoteRunnerHost::read_file(&sftp, &runner_path, MAX_REMOTE_FILE_BYTES)?
            .ok_or_else(|| RunnerFailure::ambiguous("Remote runner binary is missing"))?;
    let runner_identity_verified = sha256_bytes(&runner_bytes) == expected_runner_sha256;
    if !runner_identity_verified {
        return Err(RunnerFailure::ambiguous(
            "Remote runner binary digest changed",
        ));
    }
    let accepted_path = NativeRemoteRunnerHost::join(&run_path, "launch.accepted")?;
    let accepted = NativeRemoteRunnerHost::read_file(&sftp, &accepted_path, 128)?;
    let launch_accepted =
        accepted.as_deref() == Some(format!("{expected_runner_sha256}\n").as_bytes());
    if accepted.is_some() && !launch_accepted {
        return Err(RunnerFailure::ambiguous(
            "Remote launch acceptance identity changed",
        ));
    }
    let observation = observe_read_only(&sftp, &root, &run.id)?;
    let current_path = NativeRemoteRunnerHost::join(&root, "current")?;
    let previous_path = NativeRemoteRunnerHost::join(&root, "previous")?;
    let current_release_id = read_release_link(&sftp, &current_path)?;
    let previous_release_id = read_release_link(&sftp, &previous_path)?;
    let target = &plan.approval_summary.frozen.target_release;
    let target_release_verified = read_release_digest(&sftp, &root, &target.release_id)?.as_deref()
        == Some(&target.artifact_digest_sha256);
    let rollback_release_verified = match &plan.approval_summary.frozen.rollback_release {
        Some(rollback) => {
            read_release_digest(&sftp, &root, &rollback.release_id)?.as_deref()
                == Some(&rollback.artifact_digest_sha256)
        }
        None => false,
    };
    let mut compose_services_verified = false;
    let mut health_verified = false;
    if let Some(active_release_id) = current_release_id.as_deref() {
        let approved_release = std::iter::once(&plan.approval_summary.frozen.target_release)
            .chain(plan.approval_summary.frozen.rollback_release.as_ref())
            .find(|release| release.release_id == active_release_id);
        if approved_release.is_some() {
            let target_active = active_release_id == target.release_id;
            let image_reference = format!(
                "{}:{}",
                workflow.definition.build.image_repository, active_release_id
            );
            let expected_image_id =
                target_active.then_some(artifact.manifest.image.image_id.as_str());
            let services = read_service_scope(
                &sftp,
                &root,
                active_release_id,
                &plan.approval_summary.services,
            )?;
            let health = workflow.definition.health_check.as_ref();
            let command = compose_probe_command(
                &plan.approval_summary.compose_project,
                &image_reference,
                expected_image_id,
                health.map(|value| value.path.as_str()),
                &services,
            );
            match execute_ssh_channel(
                &session.target,
                &command,
                ExecutionOutputPolicy::new(32 * 1024, 4 * 1024, 64 * 1024)
                    .map_err(|_| RunnerFailure::ambiguous("Compose evidence policy is invalid"))?,
                &[],
                cancellation,
                deadline,
            ) {
                SshChannelExecutionOutcome::Completed {
                    exit_code: 0,
                    output,
                } if !output.stdout.truncated
                    && !output.stderr.truncated
                    && output.stderr.text.is_empty() =>
                {
                    (compose_services_verified, health_verified) = parse_compose_probe(
                        &output.stdout.text,
                        &services,
                        &image_reference,
                        expected_image_id,
                        health.map(|value| value.expected_status),
                    )?;
                }
                SshChannelExecutionOutcome::Cancelled => {
                    return Err(RunnerFailure::ambiguous(
                        "Reconciliation observation was stopped",
                    ))
                }
                SshChannelExecutionOutcome::TimedOut => {
                    return Err(RunnerFailure::ambiguous(
                        "Reconciliation health observation timed out",
                    ))
                }
                _ => {
                    return Err(RunnerFailure::ambiguous(
                        "Fixed read-only Compose evidence could not be obtained",
                    ))
                }
            }
        }
    }
    Ok(ReconciliationSnapshot {
        run_directory_present: true,
        launch_accepted,
        runner_identity_verified,
        request_identity_verified: true,
        observation,
        current_release_id,
        previous_release_id,
        target_release_verified,
        rollback_release_verified,
        compose_services_verified,
        health_verified,
    })
}

fn local_remote_event(
    event: &super::DeploymentRunEventRecord,
) -> Option<(u32, String, String, String)> {
    let payload = event.payload.as_ref()?;
    let sequence = payload.get("remoteSequence")?.as_u64()?.try_into().ok()?;
    let phase = payload.get("phase")?.as_str()?.to_string();
    let action = payload.get("action")?.as_str()?.to_string();
    let outcome = payload.get("outcome")?.as_str()?.to_string();
    Some((sequence, phase, action, outcome))
}

fn merge_reconciliation_events(
    database: &Database,
    request: &DeploymentReconciliationRequest,
    remote_events: &[RemoteRunnerEvent],
) -> Result<(), String> {
    let events = database.list_deployment_run_events(&request.run_id, 0, 500)?;
    let mut local = BTreeMap::new();
    for event in &events {
        if let Some((sequence, phase, action, outcome)) = local_remote_event(event) {
            if local
                .insert(sequence, (phase, action, outcome, event.summary.clone()))
                .is_some()
            {
                return Err("DEPLOYMENT_REMOTE_LEDGER_CONFLICT".into());
            }
        }
    }
    for (index, sequence) in local.keys().enumerate() {
        if *sequence != u32::try_from(index).unwrap_or(u32::MAX) + 1 {
            return Err("DEPLOYMENT_REMOTE_LEDGER_GAP".into());
        }
    }
    if local.len() > remote_events.len() {
        return Err("DEPLOYMENT_REMOTE_LEDGER_TRUNCATED".into());
    }
    for remote in remote_events.iter().take(local.len()) {
        let expected_summary = format!(
            "Remote {} for {}: {}",
            match remote.phase {
                RemoteEventPhase::Intent => "intent",
                RemoteEventPhase::Outcome => "outcome",
            },
            step_name(remote.action),
            remote.summary,
        );
        let expected = (
            match remote.phase {
                RemoteEventPhase::Intent => "intent".to_string(),
                RemoteEventPhase::Outcome => "outcome".to_string(),
            },
            step_name(remote.action).to_string(),
            remote.outcome.clone(),
            expected_summary,
        );
        if local.get(&remote.sequence) != Some(&expected) {
            return Err("DEPLOYMENT_REMOTE_LEDGER_TAMPERED".into());
        }
    }
    for remote in remote_events.iter().skip(local.len()) {
        append_event_retry(
            database,
            &request.run_id,
            DeploymentEventWrite {
                event_kind: DeploymentEventKind::StatusChanged,
                status: None,
                summary: format!(
                    "Remote {} for {}: {}",
                    match remote.phase {
                        RemoteEventPhase::Intent => "intent",
                        RemoteEventPhase::Outcome => "outcome",
                    },
                    step_name(remote.action),
                    remote.summary,
                ),
                payload: Some(serde_json::json!({
                    "operationId": request.operation_id,
                    "remoteSequence": remote.sequence,
                    "phase": match remote.phase { RemoteEventPhase::Intent => "intent", RemoteEventPhase::Outcome => "outcome" },
                    "action": step_name(remote.action),
                    "outcome": remote.outcome,
                })),
            },
        )
        .map_err(|_| "DEPLOYMENT_REMOTE_LEDGER_APPEND_FAILED".to_string())?;
    }
    Ok(())
}

fn snapshot_evidence(snapshot: &ReconciliationSnapshot) -> DeploymentReconciliationEvidence {
    DeploymentReconciliationEvidence {
        remote_sequence: snapshot
            .observation
            .status
            .as_ref()
            .map(|status| status.sequence),
        runner_identity_verified: snapshot.runner_identity_verified,
        request_identity_verified: snapshot.request_identity_verified,
        ledger_verified: true,
        current_release_id: snapshot.current_release_id.clone(),
        previous_release_id: snapshot.previous_release_id.clone(),
        target_release_verified: snapshot.target_release_verified,
        rollback_release_verified: snapshot.rollback_release_verified,
        compose_services_verified: snapshot.compose_services_verified,
        health_verified: snapshot.health_verified,
        side_effects_started: snapshot
            .observation
            .status
            .as_ref()
            .map(|status| status.side_effects_started),
        approval_reusable: false,
    }
}

fn classify_reconciliation_snapshot(
    snapshot: &ReconciliationSnapshot,
    plan: &super::DeploymentStoredPlanRecord,
    cancel_intent: bool,
    approval_reusable: bool,
) -> (
    DeploymentRunStatus,
    DeploymentReconciliationOutcome,
    DeploymentReconciliationEvidence,
) {
    let mut evidence = snapshot_evidence(snapshot);
    evidence.approval_reusable = approval_reusable;
    let current_unchanged = plan
        .approval_summary
        .frozen
        .current_release
        .as_ref()
        .map(|release| snapshot.current_release_id.as_deref() == Some(&release.release_id))
        .unwrap_or(snapshot.current_release_id.is_none());
    let Some(status) = snapshot.observation.status.as_ref() else {
        if (!snapshot.run_directory_present || !snapshot.launch_accepted) && current_unchanged {
            let next = if cancel_intent || !approval_reusable {
                DeploymentRunStatus::Canceled
            } else {
                DeploymentRunStatus::Approved
            };
            return (
                next,
                DeploymentReconciliationOutcome::NoSideEffects,
                evidence,
            );
        }
        return (
            DeploymentRunStatus::StateUnknown,
            DeploymentReconciliationOutcome::StateUnknown,
            evidence,
        );
    };
    if !snapshot.launch_accepted
        || !snapshot.runner_identity_verified
        || !snapshot.request_identity_verified
    {
        return (
            DeploymentRunStatus::StateUnknown,
            DeploymentReconciliationOutcome::StateUnknown,
            evidence,
        );
    }
    let target = &plan.approval_summary.frozen.target_release;
    let rollback = plan.approval_summary.frozen.rollback_release.as_ref();
    let target_healthy = status.state == RemoteRunnerState::Succeeded
        && status.active_release_id.as_deref() == Some(&target.release_id)
        && snapshot.current_release_id.as_deref() == Some(&target.release_id)
        && rollback.is_none_or(|release| {
            snapshot.previous_release_id.as_deref() == Some(&release.release_id)
        })
        && snapshot.target_release_verified
        && snapshot.compose_services_verified
        && snapshot.health_verified;
    if target_healthy {
        return (
            DeploymentRunStatus::Succeeded,
            DeploymentReconciliationOutcome::TargetHealthy,
            evidence,
        );
    }
    let rollback_healthy = rollback.is_some_and(|release| {
        status.state == RemoteRunnerState::RolledBack
            && status.active_release_id.as_deref() == Some(&release.release_id)
            && snapshot.current_release_id.as_deref() == Some(&release.release_id)
            && snapshot.previous_release_id.as_deref() == Some(&target.release_id)
            && snapshot.rollback_release_verified
            && snapshot.compose_services_verified
            && snapshot.health_verified
    });
    if rollback_healthy {
        return (
            if cancel_intent {
                DeploymentRunStatus::Canceled
            } else {
                DeploymentRunStatus::Failed
            },
            DeploymentReconciliationOutcome::RollbackHealthy,
            evidence,
        );
    }
    if matches!(
        status.state,
        RemoteRunnerState::InProgress | RemoteRunnerState::Verifying
    ) {
        return (
            if status.state == RemoteRunnerState::Verifying {
                DeploymentRunStatus::Verifying
            } else if cancel_intent {
                DeploymentRunStatus::CancelRequested
            } else {
                DeploymentRunStatus::InProgress
            },
            DeploymentReconciliationOutcome::StillRunning,
            evidence,
        );
    }
    if !status.side_effects_started
        && current_unchanged
        && matches!(
            status.state,
            RemoteRunnerState::Canceled
                | RemoteRunnerState::Failed
                | RemoteRunnerState::StateUnknown
        )
    {
        let next =
            if cancel_intent || status.state == RemoteRunnerState::Canceled || !approval_reusable {
                DeploymentRunStatus::Canceled
            } else {
                DeploymentRunStatus::Approved
            };
        return (
            next,
            DeploymentReconciliationOutcome::NoSideEffects,
            evidence,
        );
    }
    (
        DeploymentRunStatus::StateUnknown,
        DeploymentReconciliationOutcome::StateUnknown,
        evidence,
    )
}

fn reconciliation_summary(outcome: DeploymentReconciliationOutcome) -> &'static str {
    match outcome {
        DeploymentReconciliationOutcome::TargetHealthy => {
            "Reconciliation proved the target release active and healthy"
        }
        DeploymentReconciliationOutcome::RollbackHealthy => {
            "Reconciliation proved the frozen rollback release restored and healthy"
        }
        DeploymentReconciliationOutcome::StillRunning => {
            "Reconciliation proved the remote runner is still executing"
        }
        DeploymentReconciliationOutcome::NoSideEffects => {
            "Reconciliation proved no deployment side effect was produced"
        }
        DeploymentReconciliationOutcome::StateUnknown => {
            "Reconciliation could not prove a consistent remote deployment state"
        }
        DeploymentReconciliationOutcome::ObservationStopped => {
            "Read-only reconciliation observation was stopped without canceling deployment"
        }
    }
}

fn complete_reconciliation(
    database: &Database,
    request: &DeploymentReconciliationRequest,
    status: DeploymentRunStatus,
    outcome: DeploymentReconciliationOutcome,
    evidence: DeploymentReconciliationEvidence,
) -> Result<DeploymentReconciliationResult, String> {
    let run = database
        .get_deployment_run(&request.run_id)?
        .ok_or_else(|| "DEPLOYMENT_RUN_NOT_FOUND".to_string())?;
    if run.status != DeploymentRunStatus::Reconciling {
        return Err("REVISION_CONFLICT".into());
    }
    let result = DeploymentReconciliationResult {
        operation_id: request.operation_id.clone(),
        plan_id: request.plan_id.clone(),
        run_id: request.run_id.clone(),
        status,
        outcome,
        reconciliation_required: status == DeploymentRunStatus::StateUnknown,
        evidence,
    };
    database.transition_deployment_run_atomic(
        &run.id,
        run.last_event_sequence,
        DeploymentRunStatus::Reconciling,
        status,
        &DeploymentEventWrite {
            event_kind: DeploymentEventKind::ReconciliationCompleted,
            status: Some(status),
            summary: reconciliation_summary(outcome).into(),
            payload: Some(serde_json::json!({
                "request": reconciliation_request_payload(request),
                "result": result,
            })),
        },
    )?;
    Ok(result)
}

fn complete_unknown_reconciliation(
    database: &Database,
    request: &DeploymentReconciliationRequest,
    evidence: DeploymentReconciliationEvidence,
) -> Result<DeploymentReconciliationResult, String> {
    complete_reconciliation(
        database,
        request,
        DeploymentRunStatus::StateUnknown,
        DeploymentReconciliationOutcome::StateUnknown,
        evidence,
    )
}

pub(crate) fn reconcile_deployment_run(
    database: &Database,
    credentials: &CredentialManager,
    cancellations: &ExecutionCancellationRegistry,
    known_hosts_path: &Path,
    artifact_staging_root: &Path,
    request: DeploymentReconciliationRequest,
) -> Result<DeploymentReconciliationResult, String> {
    validate_reconciliation_request(&request)?;
    if let Some(result) = completed_reconciliation_result(database, &request)? {
        return Ok(result);
    }
    let cancellation = cancellations
        .register(request.operation_id.clone())
        .map_err(|_| "DEPLOYMENT_RECONCILIATION_OPERATION_CONFLICT".to_string())?;
    let (original_run, cancel_intent) = begin_reconciliation(database, &request)?;
    let deadline = Instant::now() + RECONCILIATION_TIMEOUT;
    let receipt =
        match database.get_deployment_transfer_receipt(&request.artifact_transfer_operation_id)? {
            Some(receipt) => receipt,
            None => {
                return complete_unknown_reconciliation(
                    database,
                    &request,
                    empty_reconciliation_evidence(),
                )
            }
        };
    let summary = &original_run.approval_summary;
    let plan = super::DeploymentStoredPlanRecord {
        plan_id: request.plan_id.clone(),
        plan_digest: request.plan_digest.clone(),
        run_id: original_run.id.clone(),
        run_revision: original_run.last_event_sequence,
        status: original_run.status,
        approval_summary: summary.clone(),
        created_at: original_run.created_at,
        expires_at: summary.expires_at,
    };
    let workflow = match database.get_deployment_workflow(&summary.workflow_id)? {
        Some(workflow)
            if workflow.revision == summary.workflow_revision
                && workflow.connection_profile_id == summary.frozen.target.profile_id
                && workflow.definition.target.remote_root == summary.remote_root
                && workflow.definition.compose.project_name == summary.compose_project
                && workflow.definition.compose.files == summary.compose_files
                && workflow.definition.compose.services == summary.services =>
        {
            workflow
        }
        _ => {
            return complete_unknown_reconciliation(
                database,
                &request,
                empty_reconciliation_evidence(),
            )
        }
    };
    let profile = match database.get_profile(&summary.frozen.target.profile_id)? {
        Some(profile)
            if target_identity(&profile).ok().as_ref() == Some(&summary.frozen.target) =>
        {
            profile
        }
        _ => {
            return complete_unknown_reconciliation(
                database,
                &request,
                empty_reconciliation_evidence(),
            )
        }
    };
    let artifact_reference = match summary.artifact_reference.as_deref() {
        Some(value) => value,
        None => {
            return complete_unknown_reconciliation(
                database,
                &request,
                empty_reconciliation_evidence(),
            )
        }
    };
    let artifact = match verify_deployment_artifact(artifact_staging_root, artifact_reference) {
        Ok(artifact)
            if artifact.manifest.workflow_id == summary.workflow_id
                && artifact.manifest.workflow_revision == summary.workflow_revision
                && artifact.manifest.source_revision == summary.frozen.source_revision
                && artifact.target_release() == summary.frozen.target_release =>
        {
            artifact
        }
        _ => {
            return complete_unknown_reconciliation(
                database,
                &request,
                empty_reconciliation_evidence(),
            )
        }
    };
    if receipt.run_id != original_run.id
        || receipt.plan_id != request.plan_id
        || receipt.plan_digest != request.plan_digest
        || receipt.request.workflow_id != summary.workflow_id
        || receipt.request.workflow_revision != summary.workflow_revision
        || receipt.request.artifact_reference != artifact_reference
        || receipt.request.source_revision != summary.frozen.source_revision
        || receipt.request.target != summary.frozen.target
        || receipt.request.remote_root != summary.remote_root
        || receipt.request.release_id != summary.frozen.target_release.release_id
        || receipt.request.release_digest_sha256
            != summary.frozen.target_release.artifact_digest_sha256
        || receipt.result.status
            != super::artifact_transfer::DeploymentArtifactTransferStatus::Succeeded
        || receipt.result.release_id != summary.frozen.target_release.release_id
        || receipt.result.remote_staging_identity.as_deref()
            != Some(&request.remote_staging_identity)
        || receipt.result.remote_digest_sha256.as_deref()
            != Some(&summary.frozen.target_release.artifact_digest_sha256)
    {
        return complete_unknown_reconciliation(
            database,
            &request,
            empty_reconciliation_evidence(),
        );
    }
    let connection = match connection_for_profile(credentials, &profile) {
        Ok(connection) => connection,
        Err(_) => {
            return complete_unknown_reconciliation(
                database,
                &request,
                empty_reconciliation_evidence(),
            )
        }
    };
    let source_current = inspect_deployment_artifact_source_with_handle(
        database,
        &summary.workflow_id,
        summary.workflow_revision,
        &cancellation,
        deadline,
    )
    .ok();
    let approval_reusable = crate::db::current_timestamp_ms() < summary.expires_at
        && source_current.as_ref() == Some(&summary.frozen.source_revision);
    let mut host = NativeRemoteRunnerHost {
        connection,
        known_hosts_path: known_hosts_path.to_path_buf(),
    };
    let mut last_running = None;
    loop {
        if cancellation.terminal_state() == ExecutionTerminalState::Cancelled {
            let (status, mut evidence) =
                last_running.unwrap_or((original_run.status, empty_reconciliation_evidence()));
            evidence.approval_reusable = approval_reusable;
            return complete_reconciliation(
                database,
                &request,
                status,
                DeploymentReconciliationOutcome::ObservationStopped,
                evidence,
            );
        }
        if Instant::now() >= deadline {
            cancellation.try_timeout();
            return complete_unknown_reconciliation(
                database,
                &request,
                last_running
                    .map(|(_, evidence)| evidence)
                    .unwrap_or_else(empty_reconciliation_evidence),
            );
        }
        let snapshot = match inspect_reconciliation_snapshot(
            &mut host,
            &request,
            &original_run,
            &receipt,
            &plan,
            &artifact,
            &workflow,
            &cancellation,
            deadline,
        ) {
            Ok(snapshot) => snapshot,
            Err(_) if cancellation.terminal_state() == ExecutionTerminalState::Cancelled => {
                continue
            }
            Err(_) => {
                return complete_unknown_reconciliation(
                    database,
                    &request,
                    last_running
                        .map(|(_, evidence)| evidence)
                        .unwrap_or_else(empty_reconciliation_evidence),
                )
            }
        };
        if merge_reconciliation_events(database, &request, &snapshot.observation.events).is_err() {
            let mut evidence = snapshot_evidence(&snapshot);
            evidence.ledger_verified = false;
            return complete_unknown_reconciliation(database, &request, evidence);
        }
        let (status, outcome, mut evidence) =
            classify_reconciliation_snapshot(&snapshot, &plan, cancel_intent, approval_reusable);
        evidence.ledger_verified = true;
        if outcome == DeploymentReconciliationOutcome::StillRunning {
            last_running = Some((status, evidence));
            std::thread::sleep(POLL_INTERVAL);
            continue;
        }
        cancellation.try_finish();
        return complete_reconciliation(database, &request, status, outcome, evidence);
    }
}

pub(crate) fn cancel_deployment_reconciliation_observation(
    cancellations: &ExecutionCancellationRegistry,
    operation_id: &str,
) -> Result<bool, String> {
    if !operation_id.starts_with(RECONCILIATION_OPERATION_PREFIX)
        || !crate::execution::valid_operation_id(operation_id)
    {
        return Err("deployment reconciliation operation ID is invalid".into());
    }
    match cancellations.cancel(operation_id) {
        Ok(()) => Ok(true),
        Err(error)
            if error.kind
                == crate::execution::ExecutionCancellationErrorKind::OperationNotFound =>
        {
            Ok(false)
        }
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn valid_remote_runner_operation_id(value: &str) -> bool {
    value.starts_with(OPERATION_PREFIX) && crate::execution::valid_operation_id(value)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::deployment::{
        DeploymentApprovalPlanSummary, DeploymentFrozenPlanInputs, DeploymentOperationKind,
        DeploymentPreflightSummary, DeploymentReleaseIdentity, DeploymentStoredPlanRecord,
    };
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    struct ScriptFixture {
        _directory: tempfile::TempDir,
        root: PathBuf,
        runner: PathBuf,
        request: PathBuf,
        run_dir: PathBuf,
        bin: PathBuf,
        call_log: PathBuf,
        state_file: PathBuf,
        cancel_file: PathBuf,
    }

    fn executable(path: &Path, contents: &str) {
        fs::write(path, contents).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    fn digest(path: &Path) -> String {
        sha256_file(path).unwrap()
    }

    fn reconciliation_plan() -> DeploymentStoredPlanRecord {
        DeploymentStoredPlanRecord {
            plan_id: format!("plan-{}", "a".repeat(64)),
            plan_digest: "a".repeat(64),
            run_id: "run-1".into(),
            run_revision: 5,
            status: DeploymentRunStatus::Reconciling,
            approval_summary: DeploymentApprovalPlanSummary {
                schema_version: 2,
                workflow_id: "workflow-1".into(),
                workflow_revision: 1,
                operation_kind: DeploymentOperationKind::Deploy,
                artifact_reference: Some(format!(
                    "deployment-artifact-v1:{}:{}",
                    "b".repeat(64),
                    "c".repeat(64)
                )),
                frozen: DeploymentFrozenPlanInputs {
                    source_revision: DeploymentFrozenSourceRevision {
                        revision: "d".repeat(40),
                        dirty: false,
                    },
                    target: DeploymentTargetIdentitySnapshot {
                        profile_id: "profile-1".into(),
                        profile_updated_at: 1,
                        host: "example.test".into(),
                        port: 22,
                        username: "deploy".into(),
                        auth_method: "key".into(),
                        jump_host: None,
                    },
                    current_release: Some(DeploymentReleaseIdentity {
                        release_id: "release-old".into(),
                        artifact_digest_sha256: "e".repeat(64),
                    }),
                    target_release: DeploymentReleaseIdentity {
                        release_id: "release-new".into(),
                        artifact_digest_sha256: "f".repeat(64),
                    },
                    rollback_release: Some(DeploymentReleaseIdentity {
                        release_id: "release-old".into(),
                        artifact_digest_sha256: "e".repeat(64),
                    }),
                    preflight: DeploymentPreflightSummary {
                        checked_at: 1,
                        checks: Vec::new(),
                    },
                },
                remote_root: "/srv/app".into(),
                compose_project: "app".into(),
                compose_files: vec!["compose.yaml".into()],
                services: vec!["web".into()],
                actions: Vec::new(),
                generated_at: 1,
                expires_at: 60_001,
            },
            created_at: 1,
            expires_at: 60_001,
        }
    }

    fn reconciliation_snapshot(state: RemoteRunnerState) -> ReconciliationSnapshot {
        ReconciliationSnapshot {
            run_directory_present: true,
            launch_accepted: true,
            runner_identity_verified: true,
            request_identity_verified: true,
            observation: RemoteObservation {
                status: Some(RemoteRunnerStatus {
                    state,
                    step: DeploymentRemoteRunnerStep::RecordResult,
                    side_effects_started: true,
                    active_release_id: Some("release-new".into()),
                    rollback_release_id: Some("release-old".into()),
                    failure_category: None,
                    sequence: 8,
                    summary: "proved".into(),
                }),
                events: Vec::new(),
            },
            current_release_id: Some("release-new".into()),
            previous_release_id: Some("release-old".into()),
            target_release_verified: true,
            rollback_release_verified: true,
            compose_services_verified: true,
            health_verified: true,
        }
    }

    fn fixture(nginx_reload: bool) -> ScriptFixture {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("remote");
        let run_dir = root.join(".shellspan/runs/run-1");
        let staging = root.join(format!(".shellspan/staging/{}", "a".repeat(64)));
        let bin = directory.path().join("bin");
        fs::create_dir_all(run_dir.join("events")).unwrap();
        fs::create_dir_all(staging.join("compose")).unwrap();
        fs::create_dir_all(&bin).unwrap();
        fs::write(staging.join("image.tar"), b"verified image archive").unwrap();
        fs::write(staging.join("manifest.json"), b"{}\n").unwrap();
        fs::write(
            staging.join("compose/compose.yaml"),
            b"services:\n  web:\n    image: old\n",
        )
        .unwrap();

        let old = root.join("releases/release-old");
        fs::create_dir_all(old.join("compose")).unwrap();
        fs::write(
            old.join("compose/compose.yaml"),
            b"services:\n  web:\n    image: old\n",
        )
        .unwrap();
        fs::write(
            old.join(".shellspan-artifact-sha256"),
            format!("{}\n", "b".repeat(64)),
        )
        .unwrap();
        fs::write(
            old.join(".shellspan.override.yaml"),
            b"services:\n  web:\n    image: example.test/app:release-old\n",
        )
        .unwrap();
        fs::write(old.join(".shellspan.services"), b"web\n").unwrap();

        let runner = directory.path().join("runner.sh");
        executable(&runner, REMOTE_RUNNER_SCRIPT);
        let runner_sha = digest(&runner);
        let archive_sha = digest(&staging.join("image.tar"));
        let manifest_sha = digest(&staging.join("manifest.json"));
        let compose_sha = digest(&staging.join("compose/compose.yaml"));
        let mut body = String::new();
        request_line("schema_version", 1, &mut body);
        request_line("runner_version", RUNNER_VERSION, &mut body);
        request_line("runner_sha256", &runner_sha, &mut body);
        request_line("operation_id", "deployment-remote-runner:test", &mut body);
        request_line("plan_id", format!("plan-{}", "c".repeat(64)), &mut body);
        request_line("plan_digest", "c".repeat(64), &mut body);
        request_line("run_id", "run-1", &mut body);
        request_line(
            "expires_at_seconds",
            current_unix_seconds().saturating_add(60),
            &mut body,
        );
        request_line("remote_root", root.to_string_lossy(), &mut body);
        request_line("content_identity", "a".repeat(64), &mut body);
        request_line("manifest_digest", "d".repeat(64), &mut body);
        request_line("manifest_file_sha256", manifest_sha, &mut body);
        request_line("release_id", "release-new", &mut body);
        request_line("release_digest", &archive_sha, &mut body);
        request_line("archive_file", "image.tar", &mut body);
        request_line("archive_compression", "none", &mut body);
        request_line("archive_sha256", &archive_sha, &mut body);
        request_line("image_repository", "example.test/app", &mut body);
        request_line("image_tag", "release-new", &mut body);
        request_line("image_id", format!("sha256:{}", "e".repeat(64)), &mut body);
        request_line("compose_project", "app", &mut body);
        request_line("pull_before_up", 0, &mut body);
        request_line("health_enabled", 1, &mut body);
        request_line("health_path", "/healthz", &mut body);
        request_line("health_status", 200, &mut body);
        request_line("health_timeout", 1, &mut body);
        request_line("nginx_reload", u8::from(nginx_reload), &mut body);
        request_line("rollback_release_id", "release-old", &mut body);
        request_line("rollback_release_digest", "b".repeat(64), &mut body);
        request_line("compose_count", 1, &mut body);
        request_line("compose_0_path", "compose.yaml", &mut body);
        request_line("compose_0_file", "compose/compose.yaml", &mut body);
        request_line("compose_0_sha256", compose_sha, &mut body);
        request_line("service_count", 1, &mut body);
        request_line("service_0", "web", &mut body);
        request_line("end", 1, &mut body);
        let mut request_contents = String::new();
        request_line(
            "request_digest",
            sha256_bytes(body.as_bytes()),
            &mut request_contents,
        );
        request_contents.push_str(&body);
        let request = run_dir.join("request.v1.tsv");
        fs::write(&request, request_contents).unwrap();

        let call_log = directory.path().join("calls.log");
        let state_file = directory.path().join("active-state");
        let cancel_file = run_dir.join("cancel.requested");
        executable(
            &bin.join("docker"),
            r#"#!/bin/sh
printf 'docker %s\n' "$*" >> "$CALL_LOG"
if [ "${1-}" = load ]; then
  cat "$3" >/dev/null
  [ "${SCENARIO-}" != load_fail ]
  exit
fi
if [ "${1-}" = image ] && [ "${2-}" = inspect ]; then
  if [ "${SCENARIO-}" = image_mismatch ]; then printf 'sha256:%064d\n' 0; else printf '%s\n' "$IMAGE_ID"; fi
  exit 0
fi
case " $* " in
  *" config --services "*) printf 'web\n'; exit 0 ;;
  *" config "*) [ "${SCENARIO-}" != compose_config_fail ]; exit ;;
  *" ps --status running --services "*) printf 'web\n'; exit 0 ;;
  *" up -d --no-build --pull never "*)
    case "$*" in *release-old*) selected=old ;; *) selected=new ;; esac
    printf '%s\n' "$selected" > "$STATE_FILE"
    if [ "${SCENARIO-}" = compose_up_fail ] && [ "$selected" = new ]; then exit 1; fi
    if [ "${SCENARIO-}" = rollback_fail ] && [ "$selected" = old ]; then exit 1; fi
    if [ "${SCENARIO-}" = cancel_after_up ] && [ "$selected" = new ]; then printf cancel > "$CANCEL_FILE"; fi
    exit 0
    ;;
esac
exit 0
"#,
        );
        executable(
            &bin.join("curl"),
            r#"#!/bin/sh
printf 'curl %s\n' "$*" >> "$CALL_LOG"
selected=$(sed -n '1p' "$STATE_FILE" 2>/dev/null || true)
case "${SCENARIO-}:$selected" in health_fail:new|rollback_fail:new) printf 503 ;; *) printf 200 ;; esac
"#,
        );
        executable(
            &bin.join("nginx"),
            r#"#!/bin/sh
printf 'nginx %s\n' "$*" >> "$CALL_LOG"
[ "${SCENARIO-}" != nginx_test_fail ]
"#,
        );
        executable(
            &bin.join("sudo"),
            r#"#!/bin/sh
printf 'sudo %s\n' "$*" >> "$CALL_LOG"
[ "${SCENARIO-}" != nginx_reload_fail ]
"#,
        );
        executable(
            &bin.join("flock"),
            r#"#!/bin/sh
[ "${SCENARIO-}" != lock_conflict ]
"#,
        );
        executable(
            &bin.join("mv"),
            r#"#!/bin/sh
if [ "${1-}" = -Tf ]; then exec /bin/mv -f "$2" "$3"; fi
exec /bin/mv "$@"
"#,
        );
        ScriptFixture {
            _directory: directory,
            root,
            runner,
            request,
            run_dir,
            bin,
            call_log,
            state_file,
            cancel_file,
        }
    }

    fn current_unix_seconds() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    fn run_script(fixture: &ScriptFixture, scenario: &str) -> RemoteRunnerStatus {
        let path = format!(
            "{}:{}",
            fixture.bin.to_string_lossy(),
            std::env::var("PATH").unwrap_or_default()
        );
        let status = Command::new("sh")
            .arg(&fixture.runner)
            .arg(&fixture.request)
            .arg(&fixture.run_dir)
            .env("PATH", path)
            .env("SCENARIO", scenario)
            .env("CALL_LOG", &fixture.call_log)
            .env("STATE_FILE", &fixture.state_file)
            .env("CANCEL_FILE", &fixture.cancel_file)
            .env("IMAGE_ID", format!("sha256:{}", "e".repeat(64)))
            .status()
            .unwrap();
        assert!(status.success());
        parse_remote_status(&fs::read(fixture.run_dir.join("status.v1")).unwrap()).unwrap()
    }

    #[test]
    fn fixed_runner_executes_config_up_health_and_activation() {
        let fixture = fixture(false);
        let status = run_script(&fixture, "success");
        assert_eq!(status.state, RemoteRunnerState::Succeeded);
        assert_eq!(status.active_release_id.as_deref(), Some("release-new"));
        let calls = fs::read_to_string(&fixture.call_log).unwrap();
        assert!(calls.contains(" config"));
        assert!(calls.contains("up -d --no-build --pull never web"));
        assert!(calls.contains("curl"));
        assert!(!calls.contains("restart"));
    }

    #[test]
    fn health_failure_restores_only_after_verified_rollback_health() {
        let fixture = fixture(false);
        let status = run_script(&fixture, "health_fail");
        assert_eq!(status.state, RemoteRunnerState::RolledBack);
        assert_eq!(status.active_release_id.as_deref(), Some("release-old"));
        assert_eq!(
            status.failure_category,
            Some(DeploymentRemoteRunnerFailureCategory::HealthCheckFailed)
        );
    }

    #[test]
    fn rollback_failure_is_state_unknown_and_never_claims_restore() {
        let fixture = fixture(false);
        let status = run_script(&fixture, "rollback_fail");
        assert_eq!(status.state, RemoteRunnerState::StateUnknown);
        assert_eq!(
            status.failure_category,
            Some(DeploymentRemoteRunnerFailureCategory::RollbackFailed)
        );
        assert!(status.rollback_release_id.is_none());
    }

    #[test]
    fn nginx_test_failure_never_reloads_and_reload_success_reverifies_health() {
        let failed = fixture(true);
        let status = run_script(&failed, "nginx_test_fail");
        assert_eq!(status.state, RemoteRunnerState::RolledBack);
        let calls = fs::read_to_string(&failed.call_log).unwrap();
        assert!(calls.contains("nginx -t"));
        assert!(!calls.contains("sudo -n systemctl reload nginx"));

        let succeeded = fixture(true);
        let status = run_script(&succeeded, "success");
        assert_eq!(status.state, RemoteRunnerState::Succeeded);
        let calls = fs::read_to_string(&succeeded.call_log).unwrap();
        let nginx = calls.find("nginx -t").unwrap();
        let reload = calls.find("sudo -n systemctl reload nginx").unwrap();
        assert!(nginx < reload);
        assert!(calls.matches("curl").count() >= 2);
    }

    #[test]
    fn staging_tamper_image_mismatch_and_compose_failures_are_closed() {
        let tampered = fixture(false);
        fs::write(
            tampered
                .root
                .join(format!(".shellspan/staging/{}/image.tar", "a".repeat(64))),
            b"tampered",
        )
        .unwrap();
        let status = run_script(&tampered, "success");
        assert_eq!(status.state, RemoteRunnerState::Failed);
        assert_eq!(
            status.failure_category,
            Some(DeploymentRemoteRunnerFailureCategory::StagingInvalid)
        );

        let mismatch = fixture(false);
        let status = run_script(&mismatch, "image_mismatch");
        assert_eq!(
            status.failure_category,
            Some(DeploymentRemoteRunnerFailureCategory::ImageMismatch)
        );

        let load = fixture(false);
        let status = run_script(&load, "load_fail");
        assert_eq!(
            status.failure_category,
            Some(DeploymentRemoteRunnerFailureCategory::ImageLoadFailed)
        );

        let config = fixture(false);
        let status = run_script(&config, "compose_config_fail");
        assert_eq!(
            status.failure_category,
            Some(DeploymentRemoteRunnerFailureCategory::ComposeConfigFailed)
        );

        let up = fixture(false);
        let status = run_script(&up, "compose_up_fail");
        assert_eq!(status.state, RemoteRunnerState::RolledBack);
        assert_eq!(
            status.failure_category,
            Some(DeploymentRemoteRunnerFailureCategory::ComposeUpFailed)
        );
    }

    #[test]
    fn cancellation_before_compose_is_canceled_and_after_up_is_rolled_back() {
        let before = fixture(false);
        fs::write(&before.cancel_file, b"cancel").unwrap();
        let status = run_script(&before, "success");
        assert_eq!(status.state, RemoteRunnerState::Canceled);
        assert!(!before.call_log.exists());

        let after = fixture(false);
        let status = run_script(&after, "cancel_after_up");
        assert_eq!(status.state, RemoteRunnerState::RolledBack);
        assert_eq!(status.active_release_id.as_deref(), Some("release-old"));
    }

    #[test]
    fn lock_conflict_is_definite_and_disconnect_maps_only_to_state_unknown() {
        let fixture = fixture(false);
        let status = run_script(&fixture, "lock_conflict");
        assert_eq!(status.state, RemoteRunnerState::Failed);
        assert_eq!(
            status.failure_category,
            Some(DeploymentRemoteRunnerFailureCategory::LockConflict)
        );

        let request = DeploymentRemoteRunnerRequest {
            operation_id: "deployment-remote-runner:disconnect".into(),
            plan_id: format!("plan-{}", "a".repeat(64)),
            plan_digest: "a".repeat(64),
            run_id: "run-1".into(),
            run_revision: 3,
            plan_expires_at: 1,
            workflow_id: "workflow-1".into(),
            workflow_revision: 1,
            artifact_reference: format!(
                "deployment-artifact-v1:{}:{}",
                "b".repeat(64),
                "c".repeat(64)
            ),
            artifact_transfer_operation_id: "deployment-artifact-transfer:one".into(),
            source_revision: DeploymentFrozenSourceRevision {
                revision: "d".repeat(40),
                dirty: false,
            },
            target: DeploymentTargetIdentitySnapshot {
                profile_id: "profile-1".into(),
                profile_updated_at: 1,
                host: "example.test".into(),
                port: 22,
                username: "deploy".into(),
                auth_method: "key".into(),
                jump_host: None,
            },
            remote_root: "/srv/app".into(),
            release_id: "release-new".into(),
            release_digest_sha256: "e".repeat(64),
            remote_staging_identity: format!(
                "deployment-staging-v1:{}:{}",
                "b".repeat(64),
                "c".repeat(64)
            ),
            timeout_ms: 60_000,
        };
        let result = failure_result(
            &request,
            DeploymentRemoteRunnerFailureCategory::StateUnknown,
            true,
        );
        assert_eq!(result.status, DeploymentRemoteRunnerStatus::StateUnknown);
        assert!(result.reconciliation_required);
    }

    #[test]
    fn remote_status_rejects_unknown_fields_and_states() {
        let valid = b"schemaVersion=1\nstate=succeeded\nstep=recordResult\nsideEffectsStarted=1\nactiveReleaseId=release-new\nrollbackReleaseId=release-old\nfailureCategory=\nsequence=4\nsummary=done\n";
        assert!(parse_remote_status(valid).is_ok());
        let unknown = [valid.as_slice(), b"command=whoami\n"].concat();
        assert!(parse_remote_status(&unknown).is_err());
        let invented = String::from_utf8(valid.to_vec())
            .unwrap()
            .replace("state=succeeded", "state=invented");
        assert!(parse_remote_status(invented.as_bytes()).is_err());
    }

    #[test]
    fn reconciliation_classifies_target_rollback_running_and_no_effects_from_evidence() {
        let plan = reconciliation_plan();
        let target = reconciliation_snapshot(RemoteRunnerState::Succeeded);
        assert_eq!(
            classify_reconciliation_snapshot(&target, &plan, false, false).0,
            DeploymentRunStatus::Succeeded
        );

        let mut rollback = reconciliation_snapshot(RemoteRunnerState::RolledBack);
        rollback
            .observation
            .status
            .as_mut()
            .unwrap()
            .active_release_id = Some("release-old".into());
        rollback.current_release_id = Some("release-old".into());
        rollback.previous_release_id = Some("release-new".into());
        assert_eq!(
            classify_reconciliation_snapshot(&rollback, &plan, false, false).0,
            DeploymentRunStatus::Failed
        );
        assert_eq!(
            classify_reconciliation_snapshot(&rollback, &plan, true, false).0,
            DeploymentRunStatus::Canceled
        );

        let running = reconciliation_snapshot(RemoteRunnerState::InProgress);
        let classified = classify_reconciliation_snapshot(&running, &plan, false, false);
        assert_eq!(classified.0, DeploymentRunStatus::InProgress);
        assert_eq!(classified.1, DeploymentReconciliationOutcome::StillRunning);

        let mut no_effects = reconciliation_snapshot(RemoteRunnerState::Failed);
        no_effects
            .observation
            .status
            .as_mut()
            .unwrap()
            .side_effects_started = false;
        no_effects.current_release_id = Some("release-old".into());
        assert_eq!(
            classify_reconciliation_snapshot(&no_effects, &plan, false, true).0,
            DeploymentRunStatus::Approved
        );
        assert_eq!(
            classify_reconciliation_snapshot(&no_effects, &plan, true, true).0,
            DeploymentRunStatus::Canceled
        );
    }

    #[test]
    fn reconciliation_fails_closed_on_link_health_or_ledger_contradictions() {
        let plan = reconciliation_plan();
        for snapshot in [
            {
                let mut value = reconciliation_snapshot(RemoteRunnerState::Succeeded);
                value.current_release_id = Some("release-other".into());
                value
            },
            {
                let mut value = reconciliation_snapshot(RemoteRunnerState::Succeeded);
                value.compose_services_verified = false;
                value
            },
            {
                let mut value = reconciliation_snapshot(RemoteRunnerState::Succeeded);
                value.health_verified = false;
                value
            },
        ] {
            let classified = classify_reconciliation_snapshot(&snapshot, &plan, false, false);
            assert_eq!(classified.0, DeploymentRunStatus::StateUnknown);
            assert_eq!(classified.1, DeploymentReconciliationOutcome::StateUnknown);
        }

        let event = b"schemaVersion=1\nsequence=2\nphase=outcome\naction=composeUp\noutcome=succeeded\nsummary=done\n";
        assert!(parse_remote_event(event, 1).is_err());
        let tampered = b"schemaVersion=1\nsequence=1\nphase=outcome\naction=unknown\noutcome=succeeded\nsummary=done\n";
        assert!(parse_remote_event(tampered, 1).is_err());
    }

    struct IsolatedDindFixture {
        connection: RemoteConnectionRequest,
        _known_hosts_directory: tempfile::TempDir,
        known_hosts_path: PathBuf,
        root: String,
        archive: PathBuf,
        compose: PathBuf,
    }

    impl IsolatedDindFixture {
        fn from_environment() -> Self {
            let connection = crate::execution::fixture::isolated_ssh_connection();
            let (known_hosts_directory, known_hosts_path) =
                crate::connection::trusted_known_hosts_fixture(&connection.host, connection.port);
            let root = std::env::var("SHELLSPAN_DEPLOYMENT_E2E_ROOT")
                .expect("SHELLSPAN_DEPLOYMENT_E2E_ROOT is required");
            assert_eq!(root, "/srv/shellspan-deployment");
            Self {
                connection,
                _known_hosts_directory: known_hosts_directory,
                known_hosts_path,
                root,
                archive: PathBuf::from(
                    std::env::var("SHELLSPAN_DEPLOYMENT_E2E_IMAGE_ARCHIVE")
                        .expect("SHELLSPAN_DEPLOYMENT_E2E_IMAGE_ARCHIVE is required"),
                ),
                compose: PathBuf::from(
                    std::env::var("SHELLSPAN_DEPLOYMENT_E2E_COMPOSE")
                        .expect("SHELLSPAN_DEPLOYMENT_E2E_COMPOSE is required"),
                ),
            }
        }

        fn session(&self) -> crate::execution::SshExecutionSession {
            open_ssh_execution_session(&self.connection, &self.known_hosts_path)
                .expect("connect to isolated deployment SSH fixture")
        }

        fn ensure_directory(sftp: &Sftp, path: &str) {
            let mut current = String::new();
            for component in path.split('/').filter(|component| !component.is_empty()) {
                current.push('/');
                current.push_str(component);
                match sftp.lstat(Path::new(&current)) {
                    Ok(stat) => assert!(stat.file_type() == FileType::Directory),
                    Err(error) if error.code() == ErrorCode::SFTP(LIBSSH2_FX_NO_SUCH_FILE) => {
                        sftp.mkdir(Path::new(&current), 0o700).unwrap();
                    }
                    Err(error) => panic!("failed to inspect fixture directory {current}: {error}"),
                }
            }
        }

        fn write_remote(sftp: &Sftp, path: &str, bytes: &[u8], mode: i32) {
            let parent = Path::new(path)
                .parent()
                .and_then(Path::to_str)
                .expect("fixture remote path has a parent");
            Self::ensure_directory(sftp, parent);
            let mut file = sftp
                .open_mode(
                    Path::new(path),
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
                    mode,
                    OpenType::File,
                )
                .unwrap();
            file.write_all(bytes).unwrap();
            file.fsync().unwrap();
            file.close().unwrap();
            sftp.setstat(
                Path::new(path),
                FileStat {
                    size: None,
                    uid: None,
                    gid: None,
                    perm: Some(mode as u32),
                    atime: None,
                    mtime: None,
                },
            )
            .unwrap();
        }

        fn upload_remote(sftp: &Sftp, local: &Path, remote: &str) {
            let parent = Path::new(remote)
                .parent()
                .and_then(Path::to_str)
                .expect("fixture remote path has a parent");
            Self::ensure_directory(sftp, parent);
            let mut source = std::fs::File::open(local).unwrap();
            let mut destination = sftp
                .open_mode(
                    Path::new(remote),
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
                    0o600,
                    OpenType::File,
                )
                .unwrap();
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let count = source.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                destination.write_all(&buffer[..count]).unwrap();
            }
            destination.fsync().unwrap();
            destination.close().unwrap();
        }

        fn remote_sha256(sftp: &Sftp, remote: &str) -> Option<String> {
            let mut file = match sftp.open(Path::new(remote)) {
                Ok(file) => file,
                Err(error) if error.code() == ErrorCode::SFTP(LIBSSH2_FX_NO_SUCH_FILE) => {
                    return None
                }
                Err(error) => panic!("failed to open fixture file {remote}: {error}"),
            };
            let mut digest = Sha256::new();
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let count = file.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                digest.update(&buffer[..count]);
            }
            Some(hex_digest(digest.finalize()))
        }

        fn read_remote(sftp: &Sftp, path: &str) -> Option<Vec<u8>> {
            let file = match sftp.open(Path::new(path)) {
                Ok(file) => file,
                Err(error) if error.code() == ErrorCode::SFTP(LIBSSH2_FX_NO_SUCH_FILE) => {
                    return None
                }
                Err(error) => panic!("failed to read fixture file {path}: {error}"),
            };
            let mut bytes = Vec::new();
            file.take((MAX_REMOTE_FILE_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .unwrap();
            assert!(bytes.len() <= MAX_REMOTE_FILE_BYTES);
            Some(bytes)
        }

        fn exec(&self, command: &str) -> (i32, String) {
            let session = self.session();
            let mut channel = session.target.channel_session().unwrap();
            start_ssh_exec_channel(&mut channel, command).unwrap();
            let mut output = String::new();
            channel.read_to_string(&mut output).unwrap();
            channel.wait_close().unwrap();
            (channel.exit_status().unwrap(), output)
        }

        fn stage_and_launch(
            &self,
            run_id: &str,
            release_id: &str,
            image_id: &str,
            rollback: Option<(&str, &str)>,
            nginx_reload: bool,
            cancel_before_launch: bool,
            health_timeout: u8,
        ) -> String {
            let archive_sha = sha256_file(&self.archive).unwrap();
            let compose_bytes = fs::read(&self.compose).unwrap();
            let manifest_bytes = b"{}\n";
            let compose_sha = sha256_bytes(&compose_bytes);
            let manifest_sha = sha256_bytes(manifest_bytes);
            let runner_sha = sha256_bytes(REMOTE_RUNNER_SCRIPT.as_bytes());
            let content_identity = archive_sha.clone();
            let staging = format!("{}/.shellspan/staging/{content_identity}", self.root);
            let run_dir = format!("{}/.shellspan/runs/{run_id}", self.root);
            let runner_path = format!("{}/.shellspan/runners/{runner_sha}", self.root);
            let request_path = format!("{run_dir}/request.v1.tsv");
            let plan_digest = sha256_bytes(run_id.as_bytes());
            let mut body = String::new();
            request_line("schema_version", 1, &mut body);
            request_line("runner_version", RUNNER_VERSION, &mut body);
            request_line("runner_sha256", &runner_sha, &mut body);
            request_line(
                "operation_id",
                format!("deployment-remote-runner:{run_id}"),
                &mut body,
            );
            request_line("plan_id", format!("plan-{plan_digest}"), &mut body);
            request_line("plan_digest", &plan_digest, &mut body);
            request_line("run_id", run_id, &mut body);
            request_line(
                "expires_at_seconds",
                current_unix_seconds().saturating_add(300),
                &mut body,
            );
            request_line("remote_root", &self.root, &mut body);
            request_line("content_identity", &content_identity, &mut body);
            request_line("manifest_digest", "a".repeat(64), &mut body);
            request_line("manifest_file_sha256", &manifest_sha, &mut body);
            request_line("release_id", release_id, &mut body);
            request_line("release_digest", &archive_sha, &mut body);
            request_line("archive_file", "image.tar", &mut body);
            request_line("archive_compression", "none", &mut body);
            request_line("archive_sha256", &archive_sha, &mut body);
            request_line("image_repository", "shellspan/deployment-e2e", &mut body);
            request_line("image_tag", release_id, &mut body);
            request_line("image_id", image_id, &mut body);
            request_line("compose_project", "shellspan-e2e", &mut body);
            request_line("pull_before_up", 0, &mut body);
            request_line("health_enabled", 1, &mut body);
            request_line("health_path", "/healthz", &mut body);
            request_line("health_status", 200, &mut body);
            request_line("health_timeout", health_timeout, &mut body);
            request_line("nginx_reload", u8::from(nginx_reload), &mut body);
            request_line(
                "rollback_release_id",
                rollback.map(|value| value.0).unwrap_or(""),
                &mut body,
            );
            request_line(
                "rollback_release_digest",
                rollback.map(|value| value.1).unwrap_or(""),
                &mut body,
            );
            request_line("compose_count", 1, &mut body);
            request_line("compose_0_path", "compose.yaml", &mut body);
            request_line("compose_0_file", "compose/compose.yaml", &mut body);
            request_line("compose_0_sha256", compose_sha, &mut body);
            request_line("service_count", 1, &mut body);
            request_line("service_0", "web", &mut body);
            request_line("end", 1, &mut body);
            let mut request = String::new();
            request_line(
                "request_digest",
                sha256_bytes(body.as_bytes()),
                &mut request,
            );
            request.push_str(&body);

            {
                let session = self.session();
                let sftp = session.target.sftp().unwrap();
                Self::ensure_directory(&sftp, &format!("{run_dir}/events"));
                Self::ensure_directory(&sftp, &format!("{staging}/compose"));
                let remote_archive = format!("{staging}/image.tar");
                match Self::remote_sha256(&sftp, &remote_archive) {
                    Some(remote_sha) => assert_eq!(remote_sha, archive_sha),
                    None => Self::upload_remote(&sftp, &self.archive, &remote_archive),
                }
                Self::write_remote(
                    &sftp,
                    &format!("{staging}/manifest.json"),
                    manifest_bytes,
                    0o600,
                );
                Self::write_remote(
                    &sftp,
                    &format!("{staging}/compose/compose.yaml"),
                    &compose_bytes,
                    0o600,
                );
                Self::write_remote(&sftp, &runner_path, REMOTE_RUNNER_SCRIPT.as_bytes(), 0o700);
                Self::write_remote(&sftp, &request_path, request.as_bytes(), 0o600);
                Self::write_remote(
                    &sftp,
                    &format!("{run_dir}/launch.accepted"),
                    format!("{runner_sha}\n").as_bytes(),
                    0o600,
                );
                if cancel_before_launch {
                    Self::write_remote(
                        &sftp,
                        &format!("{run_dir}/cancel.requested"),
                        b"fixture cancellation\n",
                        0o600,
                    );
                }
            }

            let command = format!(
                "nohup '{runner_path}' '{request_path}' '{run_dir}' </dev/null >/dev/null 2>&1 &"
            );
            let (exit_code, output) = self.exec(&command);
            assert_eq!(exit_code, 0);
            assert!(output.is_empty());
            archive_sha
        }

        fn image_id(&self, release_id: &str) -> String {
            super::super::artifact::docker_archive_image_id(
                &self.archive,
                &format!("shellspan/deployment-e2e:{release_id}"),
            )
            .unwrap()
        }

        fn wait_status(&self, run_id: &str) -> RemoteRunnerStatus {
            let deadline = Instant::now() + Duration::from_secs(90);
            loop {
                let session = self.session();
                let sftp = session.target.sftp().unwrap();
                let path = format!("{}/.shellspan/runs/{run_id}/status.v1", self.root);
                if let Some(bytes) = Self::read_remote(&sftp, &path) {
                    let status = parse_remote_status(&bytes).unwrap();
                    if !matches!(
                        status.state,
                        RemoteRunnerState::InProgress | RemoteRunnerState::Verifying
                    ) {
                        return status;
                    }
                }
                assert!(Instant::now() < deadline, "fixture runner did not finish");
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }

    #[test]
    #[ignore = "requires the isolated tests/deployment-e2e DinD SSH fixture"]
    fn isolated_deployment_dind_remote_runner_acceptance() {
        let fixture = IsolatedDindFixture::from_environment();
        let bundle_digest = fixture.stage_and_launch(
            "run-fixture-healthy",
            "fixture-healthy",
            &fixture.image_id("fixture-healthy"),
            None,
            false,
            false,
            20,
        );
        let healthy = fixture.wait_status("run-fixture-healthy");
        if healthy.state != RemoteRunnerState::Succeeded {
            let diagnostic = fixture.exec(
                "docker ps --format '{{.Image}}|{{.Status}}|{{.Ports}}'; printf 'http='; curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1/healthz || true",
            );
            eprintln!("isolated healthy diagnostic: {diagnostic:?}");
        }
        assert_eq!(
            healthy.state,
            RemoteRunnerState::Succeeded,
            "isolated healthy deployment failed: {healthy:?}"
        );
        assert_eq!(
            healthy.active_release_id.as_deref(),
            Some("fixture-healthy")
        );
        assert_eq!(
            fixture
                .exec("readlink /srv/shellspan-deployment/current")
                .1
                .trim(),
            "releases/fixture-healthy"
        );

        fixture.stage_and_launch(
            "run-fixture-health-fail",
            "fixture-unhealthy",
            &fixture.image_id("fixture-unhealthy"),
            Some(("fixture-healthy", &bundle_digest)),
            false,
            false,
            5,
        );
        let restored = fixture.wait_status("run-fixture-health-fail");
        assert_eq!(restored.state, RemoteRunnerState::RolledBack);
        assert_eq!(
            restored.failure_category,
            Some(DeploymentRemoteRunnerFailureCategory::HealthCheckFailed)
        );
        assert_eq!(
            restored.active_release_id.as_deref(),
            Some("fixture-healthy")
        );

        let old_override = format!(
            "{}/releases/fixture-healthy/.shellspan.override.yaml",
            fixture.root
        );
        {
            let session = fixture.session();
            let sftp = session.target.sftp().unwrap();
            IsolatedDindFixture::write_remote(&sftp, &old_override, b"services: [\n", 0o600);
        }
        fixture.stage_and_launch(
            "run-fixture-rollback-fail",
            "fixture-unhealthy-rollback-fail",
            &fixture.image_id("fixture-unhealthy-rollback-fail"),
            Some(("fixture-healthy", &bundle_digest)),
            false,
            false,
            5,
        );
        let unknown = fixture.wait_status("run-fixture-rollback-fail");
        assert_eq!(unknown.state, RemoteRunnerState::StateUnknown);
        assert_eq!(
            unknown.failure_category,
            Some(DeploymentRemoteRunnerFailureCategory::RollbackFailed)
        );
        {
            let session = fixture.session();
            let sftp = session.target.sftp().unwrap();
            IsolatedDindFixture::write_remote(
                &sftp,
                &old_override,
                b"services:\n  web:\n    image: shellspan/deployment-e2e:fixture-healthy\n",
                0o600,
            );
        }

        fixture.stage_and_launch(
            "run-fixture-image-mismatch",
            "fixture-mismatch",
            &format!("sha256:{}", "0".repeat(64)),
            Some(("fixture-healthy", &bundle_digest)),
            false,
            false,
            5,
        );
        let mismatch = fixture.wait_status("run-fixture-image-mismatch");
        assert_eq!(
            mismatch.failure_category,
            Some(DeploymentRemoteRunnerFailureCategory::ImageMismatch)
        );

        let invalid_nginx = format!("{}/nginx-fixture/invalid.conf", fixture.root);
        {
            let session = fixture.session();
            let sftp = session.target.sftp().unwrap();
            IsolatedDindFixture::write_remote(
                &sftp,
                &invalid_nginx,
                b"this is not valid nginx configuration;\n",
                0o600,
            );
        }
        fixture.stage_and_launch(
            "run-fixture-nginx-fail",
            "fixture-nginx-fail",
            &fixture.image_id("fixture-nginx-fail"),
            Some(("fixture-healthy", &bundle_digest)),
            true,
            false,
            5,
        );
        let nginx_failed = fixture.wait_status("run-fixture-nginx-fail");
        assert_eq!(nginx_failed.state, RemoteRunnerState::RolledBack);
        assert_eq!(
            nginx_failed.failure_category,
            Some(DeploymentRemoteRunnerFailureCategory::NginxValidationFailed)
        );
        assert_eq!(
            fixture
                .exec("sed -n '1p' /var/lib/shellspan-fixture/nginx-reload.count 2>/dev/null || printf '0\\n'")
                .1
                .trim(),
            "0"
        );
        {
            let session = fixture.session();
            let sftp = session.target.sftp().unwrap();
            sftp.unlink(Path::new(&invalid_nginx)).unwrap();
        }
        fixture.stage_and_launch(
            "run-fixture-nginx-success",
            "fixture-nginx-success",
            &fixture.image_id("fixture-nginx-success"),
            Some(("fixture-healthy", &bundle_digest)),
            true,
            false,
            5,
        );
        let nginx_success = fixture.wait_status("run-fixture-nginx-success");
        assert_eq!(nginx_success.state, RemoteRunnerState::Succeeded);
        assert_eq!(
            fixture
                .exec("sed -n '1p' /var/lib/shellspan-fixture/nginx-reload.count")
                .1
                .trim(),
            "1"
        );

        let lock_command = "nohup sh -c 'printf %s $$ > /srv/shellspan-deployment/.shellspan/lock-owner.pid; exec 9>/srv/shellspan-deployment/.shellspan/deployment.lock; flock -x 9; printf held > /srv/shellspan-deployment/.shellspan/lock-held; exec sleep 15' </dev/null >/dev/null 2>&1 &";
        assert_eq!(fixture.exec(lock_command).0, 0);
        let lock_deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if fixture
                .exec("test -f /srv/shellspan-deployment/.shellspan/lock-held")
                .0
                == 0
            {
                break;
            }
            assert!(Instant::now() < lock_deadline);
            std::thread::sleep(Duration::from_millis(100));
        }
        fixture.stage_and_launch(
            "run-fixture-lock",
            "fixture-lock",
            &fixture.image_id("fixture-lock"),
            Some(("fixture-nginx-success", &bundle_digest)),
            false,
            false,
            5,
        );
        let locked = fixture.wait_status("run-fixture-lock");
        assert_eq!(
            locked.failure_category,
            Some(DeploymentRemoteRunnerFailureCategory::LockConflict)
        );
        assert_eq!(
            fixture
                .exec("kill \"$(cat /srv/shellspan-deployment/.shellspan/lock-owner.pid)\"")
                .0,
            0
        );

        fixture.stage_and_launch(
            "run-fixture-cancel",
            "fixture-cancel",
            &fixture.image_id("fixture-cancel"),
            Some(("fixture-nginx-success", &bundle_digest)),
            false,
            true,
            5,
        );
        let cancelled = fixture.wait_status("run-fixture-cancel");
        assert_eq!(cancelled.state, RemoteRunnerState::Canceled);
        assert!(!cancelled.side_effects_started);

        let run_dir = format!("{}/.shellspan/runs/run-fixture-nginx-success", fixture.root);
        let event_path = format!("{run_dir}/events/000001.event");
        let status_path = format!("{run_dir}/status.v1");
        let session = fixture.session();
        let sftp = session.target.sftp().unwrap();
        let original_event = IsolatedDindFixture::read_remote(&sftp, &event_path).unwrap();
        let original_status = IsolatedDindFixture::read_remote(&sftp, &status_path).unwrap();
        IsolatedDindFixture::write_remote(&sftp, &event_path, b"truncated\n", 0o600);
        assert!(observe_read_only(&sftp, &fixture.root, "run-fixture-nginx-success").is_err());
        IsolatedDindFixture::write_remote(&sftp, &event_path, &original_event, 0o600);
        IsolatedDindFixture::write_remote(&sftp, &status_path, b"schemaVersion=1\n", 0o600);
        assert!(observe_read_only(&sftp, &fixture.root, "run-fixture-nginx-success").is_err());
        IsolatedDindFixture::write_remote(&sftp, &status_path, &original_status, 0o600);
    }
}
