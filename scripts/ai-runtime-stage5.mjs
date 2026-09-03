import { spawnSync } from "node:child_process";

// Inherits the caller's toolchain/target directory; never changes repository tooling.
const formatting = spawnSync("rustfmt", [
  "--check", "--edition", "2021", "src-tauri/src/agent_runtime/scheduler_tests.rs",
], { stdio: "inherit", shell: false });
if (formatting.error) throw formatting.error;
if (formatting.status !== 0) process.exit(formatting.status ?? 1);

for (const filter of [
  "agent_runtime::runtime::tests::scheduler_tests",
  "adjacent_parallel_reads_preserve_model_order_and_stop_at_write_barriers",
  "agent_runtime::recovery::tests",
  "approval_barrier",
  "cancellation_wins_an_approved_execution_race",
  "restart_",
]) {
  const result = spawnSync("cargo", [
    "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--locked", filter,
  ], { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
