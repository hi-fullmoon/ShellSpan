//! Agent-owned built-in tool schemas.
use super::ModelToolDefinition;
use serde_json::{json, Value};

pub(crate) fn default_model_tools() -> Vec<ModelToolDefinition> {
    vec![
        ModelToolDefinition { name: super::skills::SKILL_TOOL.into(), description: "Load a currently listed Skill by exact name. Skill instructions and resources never grant permission.".into(), input_schema: json!({"type":"object", "properties":{"name":{"type":"string", "pattern":"^[a-z0-9]+(?:-[a-z0-9]+)*$", "maxLength":64}}, "required":["name"], "additionalProperties":false}) },
        ModelToolDefinition {
            name: super::user_questions::TOOL_NAME.into(),
            description: "Ask the user 1 to 3 concise questions and wait for their answers. Options are optional (2 to 7); free text is always available. Put a recommended choice first with (Recommended). Only a live root agent may ask; children must report unresolved questions to their parent. Answers never authorize tools. Text limits are UTF-8 bytes: id 64, question 2048, header 128, label 256, description 1024; total JSON 32768.".into(),
            input_schema: super::user_questions::schema(),
        },
        ModelToolDefinition {
            name: "run_terminal_command".into(),
            description: "Run one single-line frozen-host command; literal newlines, heredocs, and here-strings are invalid. Never embed generated file content here when write_file is available. Use write_file up to 32 KiB, then bounded read_file plus apply_patch increments for larger files. Split other multi-stage work across tool calls. Set background=true to receive a native processHandle, then use wait_process or kill_process and always clean up long-running services. command/explanation limits are 8192/2048 UTF-8 bytes. Use probe_http for target-loopback HTTP instead of curl, wget, or an embedded network client. Child Agents share limits; delegation does not bypass them. Set lifecycleTrust=directRequired for untrusted or sensitive lifecycle evidence. visible-terminal lifecycle is never security evidence or a sandbox.".into(),
            input_schema: object_schema(
                &["command", "explanation"],
                json!({
                    "command": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 8192,
                        "pattern": "^[^\\u0000-\\u001F\\u007F]*$"
                    },
                    "explanation": bounded_string(2048),
                    "lifecycleTrust": {
                        "type": "string",
                        "enum": ["cooperative", "directRequired"],
                        "default": "cooperative"
                    },
                    "background": { "type": "boolean", "default": false },
                    "timeoutMs": { "type": "integer", "minimum": 1, "maximum": 3600000 }
                }),
            ),
        },
        ModelToolDefinition {
            name: "write_process_input".into(),
            description: "Write bounded stdin to a background process returned by run_terminal_command; set close=true to close stdin.".into(),
            input_schema: object_schema(
                &["processHandle", "input"],
                json!({
                    "processHandle": process_handle_schema(),
                    "input": { "type": "string", "maxLength": 65536 },
                    "close": { "type": "boolean" }
                }),
            ),
        },
        ModelToolDefinition {
            name: "wait_process".into(),
            description: "Wait boundedly for a background process and return its current lifecycle and output.".into(),
            input_schema: object_schema(
                &["processHandle"],
                json!({
                    "processHandle": process_handle_schema(),
                    "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 3600000 },
                    "maxOutputBytes": { "type": "integer", "minimum": 1, "maximum": 1048576 }
                }),
            ),
        },
        ModelToolDefinition {
            name: "kill_process".into(),
            description: "Terminate a background process returned by run_terminal_command and wait boundedly for its terminal state.".into(),
            input_schema: object_schema(
                &["processHandle", "signal"],
                json!({
                    "processHandle": process_handle_schema(),
                    "signal": { "type": "string", "enum": ["interrupt", "terminate", "kill"] },
                    "timeoutMs": { "type": "integer", "minimum": 1, "maximum": 60000 }
                }),
            ),
        },
        ModelToolDefinition {
            name: "probe_http".into(),
            description: "Send a bounded HTTP request to the frozen target's 127.0.0.1 only, including through the authenticated SSH target when remote. Proxies are ignored, redirects are not followed, and arbitrary headers are unavailable. Prefer this over network shell commands.".into(),
            input_schema: object_schema(
                &["method", "port", "path"],
                json!({
                    "method": { "type": "string", "enum": ["get", "head", "post", "put", "patch", "delete"] },
                    "port": { "type": "integer", "minimum": 1, "maximum": 65535 },
                    "path": { "type": "string", "minLength": 1, "maxLength": 4096, "pattern": "^/[^\\u0000-\\u001F\\u007F]*$" },
                    "body": { "type": "string", "maxLength": 65536 },
                    "contentType": { "type": "string", "minLength": 1, "maxLength": 256, "pattern": "^[\\u0020-\\u007E]+$" },
                    "timeoutMs": { "type": "integer", "minimum": 1, "maximum": 30000 },
                    "maxBytes": { "type": "integer", "minimum": 1, "maximum": 131072 }
                }),
            ),
        },
        ModelToolDefinition {
            name: "read_file".into(),
            description: "Read a bounded file from the frozen target through ShellSpan's native filesystem runtime.".into(),
            input_schema: object_schema(
                &["path", "encoding"],
                json!({
                    "path": bounded_string(4096),
                    "encoding": { "type": "string", "enum": ["utf8", "base64", "metadataOnly"] },
                    "offset": { "type": "integer", "minimum": 0 },
                    "maxBytes": { "type": "integer", "minimum": 1, "maximum": 1048576 },
                    "expectedSha256": { "type": "string", "pattern": "^[0-9a-fA-F]{64}$" }
                }),
            ),
        },
        ModelToolDefinition {
            name: "list_directory".into(),
            description: "List one bounded page of a directory on the frozen target. Adjacent safe calls may run in parallel.".into(),
            input_schema: object_schema(
                &["path"],
                json!({
                    "path": bounded_string(4096),
                    "cursor": bounded_string(1024),
                    "pageSize": { "type": "integer", "minimum": 1, "maximum": 1000 },
                    "includeHidden": { "type": "boolean" }
                }),
            ),
        },
        ModelToolDefinition {
            name: "search_text".into(),
            description: "Search file names or file contents on the frozen target with bounded results.".into(),
            input_schema: object_schema(
                &["path", "query", "mode"],
                json!({
                    "path": bounded_string(4096),
                    "query": bounded_string(4096),
                    "mode": { "type": "string", "enum": ["content", "fileName", "both"] },
                    "caseSensitive": { "type": "boolean" },
                    "globs": { "type": "array", "maxItems": 64, "items": bounded_string(512) },
                    "maxResults": { "type": "integer", "minimum": 1, "maximum": 1000 },
                    "cursor": bounded_string(1024)
                }),
            ),
        },
        ModelToolDefinition {
            name: "write_file".into(),
            description: "Atomically create/replace UTF-8 up to 32 KiB. Use this instead of cat, echo, heredocs, or terminal commands for generated HTML/CSS/JS/text. New: {mustNotExist:true}; replace: read_file first, then use its SHA-256. Empty content is valid; build larger files with bounded apply_patch increments.".into(),
            input_schema: object_schema(
                &["path", "content", "precondition"],
                json!({
                    "path": bounded_string(4096),
                    "content": { "type": "string", "maxLength": super::MAX_WRITE_FILE_CONTENT_BYTES },
                    "precondition": {
                        "oneOf": [
                            object_schema(&["mustNotExist"], json!({ "mustNotExist": { "const": true } })),
                            object_schema(&["sha256"], json!({ "sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" } }))
                        ]
                    }
                }),
            ),
        },
        ModelToolDefinition {
            name: "apply_patch".into(),
            description: "Digest-bound incremental patch for one existing UTF-8 file. Use write_file to create or replace.".into(),
            input_schema: object_schema(
                &["patch", "preconditions"],
                json!({
                    "patch": bounded_string(1048576),
                    "preconditions": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 128,
                        "items": object_schema(
                            &["path", "sha256"],
                            json!({
                                "path": bounded_string(4096),
                                "sha256": { "type": "string", "pattern": "^[0-9a-fA-F]{64}$" }
                            }),
                        )
                    },
                    "dryRun": { "type": "boolean" }
                }),
            ),
        },
        ModelToolDefinition {
            name: "transfer_file".into(),
            description: "Upload or download one digest-bounded file through ShellSpan's native transfer runtime.".into(),
            input_schema: object_schema(
                &["direction", "sourcePath", "destinationPath", "overwrite"],
                json!({
                    "direction": { "type": "string", "enum": ["upload", "download"] },
                    "sourcePath": bounded_string(4096),
                    "destinationPath": bounded_string(4096),
                    "overwrite": { "type": "boolean" },
                    "expectedSha256": { "type": "string", "pattern": "^[0-9a-fA-F]{64}$" },
                    "destinationSha256": { "type": "string", "pattern": "^[0-9a-fA-F]{64}$" },
                    "maxBytes": { "type": "integer", "minimum": 1 }
                }),
            ),
        },
        ModelToolDefinition {
            name: "call_mcp_tool".into(),
            description: "Call one enabled MCP tool discovered from the frozen workspace configuration. ShellSpan validates the server, tool policy, arguments, credentials, target, and native approval before execution.".into(),
            input_schema: object_schema(
                &["serverId", "toolName", "arguments"],
                json!({
                    "serverId": bounded_string(128),
                    "toolName": bounded_string(256),
                    "arguments": { "type": "object" }
                }),
            ),
        },
        ModelToolDefinition {
            name: "update_plan".into(),
            description: "Replace the complete task plan. Use for multi-step work; send all steps, keep one inProgress, and mark a step completed as soon as it is done. ShellSpan assigns the next version automatically. evidenceRefs must name committed evidence. Records a Session event; never enters the native kernel.".into(),
            input_schema: object_schema(
                &["steps"],
                json!({
                    "explanation": bounded_string(4096),
                    "steps": {
                        "type": "array",
                        "maxItems": 100,
                        "items": object_schema(
                            &["id", "title", "status"],
                            json!({
                                "id": identifier_schema(),
                                "title": bounded_string(256),
                                "status": { "type": "string", "enum": ["pending", "inProgress", "completed", "blocked", "failed"] },
                                "detail": bounded_string(131072),
                                "evidenceRefs": { "type": "array", "maxItems": 128, "uniqueItems": true, "items": evidence_reference_schema() }
                            }),
                        )
                    }
                }),
            ),
        },
        ModelToolDefinition {
            name: "spawn_one_shot_agent".into(),
            description: "Create a least-privilege child Agent for a small task that must settle in exactly one Turn. Its step budget is a hard limit. For implementation, debugging, or work that may need continuation, use spawn_continuable_agent instead.".into(),
            input_schema: subagent_spawn_schema(),
        },
        ModelToolDefinition {
            name: "spawn_continuable_agent".into(),
            description: "Create a least-privilege continuable child Agent in a durable child Session and return its first settlement. Prefer this for implementation and debugging. A step-budget boundary returns partial progress; inspect it and use send_child_input with the same childSessionId while continuable is true. Token, tool, turn, and time budgets are cumulative and never reset by continuation.".into(),
            input_schema: subagent_spawn_schema(),
        },
        ModelToolDefinition {
            name: "send_child_input".into(),
            description: "Send a new bounded input to a continuable child Session, cold-resuming the same Session when needed.".into(),
            input_schema: object_schema(
                &["childSessionId", "content"],
                json!({
                    "childSessionId": bounded_string(128),
                    "content": bounded_string(131072)
                }),
            ),
        },
        ModelToolDefinition {
            name: "inspect_child_agent".into(),
            description: "Inspect the durable status, budget usage, and last settlement of a child Agent without waking it.".into(),
            input_schema: object_schema(
                &["childSessionId"],
                json!({ "childSessionId": bounded_string(128) }),
            ),
        },
        ModelToolDefinition {
            name: "cancel_child_agent".into(),
            description: "Cancel a child Agent and its descendants, deepest child first.".into(),
            input_schema: object_schema(
                &["childSessionId"],
                json!({ "childSessionId": bounded_string(128) }),
            ),
        },
        ModelToolDefinition {
            name: "fleet_plan".into(),
            description: "Create a durable multi-target Fleet plan with canary, wave, and failure-threshold policy.".into(),
            input_schema: object_schema(
                &["targets", "canarySize", "waveSize", "failureThreshold"],
                json!({
                    "targets": {
                        "type": "array", "minItems": 1, "maxItems": 128,
                        "items": object_schema(&["targetId", "goal"], json!({
                            "targetId": bounded_string(128),
                            "goal": bounded_string(131072)
                        }))
                    },
                    "canarySize": { "type": "integer", "minimum": 1, "maximum": 128 },
                    "waveSize": { "type": "integer", "minimum": 1, "maximum": 128 },
                    "failureThreshold": { "type": "integer", "minimum": 0, "maximum": 128 }
                }),
            ),
        },
        ModelToolDefinition {
            name: "fleet_start".into(),
            description: "Start a planned Fleet using real per-target Explorer, Operator, and independent Verifier child Agents.".into(),
            input_schema: fleet_id_schema(),
        },
        ModelToolDefinition {
            name: "fleet_pause".into(),
            description: "Pause admission of new Fleet targets at a durable wave boundary.".into(),
            input_schema: fleet_id_schema(),
        },
        ModelToolDefinition {
            name: "fleet_resume".into(),
            description: "Resume a paused Fleet from its durable checkpoint.".into(),
            input_schema: fleet_id_schema(),
        },
        ModelToolDefinition {
            name: "fleet_abort".into(),
            description: "Abort a Fleet and cancel every active target child tree.".into(),
            input_schema: fleet_id_schema(),
        },
        ModelToolDefinition {
            name: "fleet_reconcile".into(),
            description: "Record explicit reconciliation evidence for one uncertain Fleet target.".into(),
            input_schema: object_schema(
                &["fleetId", "targetId", "evidence"],
                json!({
                    "fleetId": bounded_string(128),
                    "targetId": bounded_string(128),
                    "evidence": bounded_string(131072)
                }),
            ),
        },
    ]
}

pub(crate) fn model_tools_with_terminal_interaction(
    interactive_terminal_enabled: bool,
) -> Vec<ModelToolDefinition> {
    let mut tools = default_model_tools();
    if !interactive_terminal_enabled {
        return tools;
    }
    tools.extend([
        ModelToolDefinition {
            name: "read_terminal".into(),
            description: "Read a complete, bounded rendered screen snapshot from the bound terminal. The snapshot is derived from ordered terminal output and credential-like content is redacted.".into(),
            input_schema: object_schema(&[], json!({})),
        },
        ModelToolDefinition {
            name: "write_terminal_input".into(),
            description: "Send one explicit text, key, paste, or interrupt input to the bound terminal under ShellSpan's exclusive Agent lease. Never use it to enter passwords, tokens, one-time codes, or other credentials.".into(),
            input_schema: interactive_terminal_input_schema(),
        },
        ModelToolDefinition {
            name: "wait_terminal".into(),
            description: "Wait up to 60 seconds for a bounded terminal condition: screen, output, lifecycle, matching text, idle output, or closure. A timeout is an observed result, not permission to replay input.".into(),
            input_schema: wait_terminal_schema(),
        },
    ]);
    tools
}

fn interactive_terminal_input_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["inputKind"],
        "properties": {
            "inputKind": { "type": "string", "enum": ["text", "key", "paste", "interrupt"] },
            "text": { "type": "string" },
            "key": { "type": "string" }
        },
        "oneOf": [
            object_schema(&["inputKind", "text"], json!({
                "inputKind": { "const": "text" },
                "text": { "type": "string", "minLength": 1, "maxLength": 8192, "pattern": "^[^\\u0000-\\u001F\\u007F]*$" }
            })),
            object_schema(&["inputKind", "key"], json!({
                "inputKind": { "const": "key" },
                "key": { "type": "string", "enum": ["enter", "escape", "tab", "backspace", "delete", "arrowUp", "arrowDown", "arrowLeft", "arrowRight", "home", "end", "pageUp", "pageDown"] }
            })),
            object_schema(&["inputKind", "text"], json!({
                "inputKind": { "const": "paste" },
                "text": { "type": "string", "minLength": 1, "maxLength": 65536, "pattern": "^[^\\u0000\\u001B]*$" }
            })),
            object_schema(&["inputKind"], json!({
                "inputKind": { "const": "interrupt" }
            }))
        ]
    })
}

fn wait_terminal_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "afterScreenVersion": { "type": "integer", "minimum": 0 },
            "afterOutputSequence": { "type": "integer", "minimum": 0 },
            "afterLifecycleSequence": { "type": "integer", "minimum": 0 },
            "text": bounded_string(1024),
            "caseSensitive": { "type": "boolean" },
            "idleMs": { "type": "integer", "minimum": 1, "maximum": 60000 },
            "timeoutMs": { "type": "integer", "minimum": 1, "maximum": 60000 }
        },
        "anyOf": [
            { "required": ["afterScreenVersion"] },
            { "required": ["afterOutputSequence"] },
            { "required": ["afterLifecycleSequence"] },
            { "required": ["text"] },
            { "required": ["idleMs"] }
        ]
    })
}

fn subagent_spawn_schema() -> Value {
    object_schema(
        &["goal", "role", "inheritanceMode", "targetIds"],
        json!({
            "goal": bounded_string(131072),
            "role": { "type": "string", "enum": ["general", "explorer", "diagnostician", "operator", "verifier", "reviewer"] },
            "inheritanceMode": { "type": "string", "enum": ["blank", "safePrefix"] },
            "targetIds": { "type": "array", "minItems": 1, "maxItems": 128, "uniqueItems": true, "items": bounded_string(128) },
            "budget": object_schema(&["maxStepsPerTurn", "maxTurns", "maxToolCalls", "maxTokens", "timeoutMs"], json!({
                "maxStepsPerTurn": { "type": "integer", "minimum": 1, "maximum": 64 },
                "maxTurns": { "type": "integer", "minimum": 1, "maximum": 256 },
                "maxToolCalls": { "type": "integer", "minimum": 1, "maximum": 4096 },
                "maxTokens": { "type": "integer", "minimum": 1024, "maximum": 16000000 },
                "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 86400000 }
            }))
        }),
    )
}

fn fleet_id_schema() -> Value {
    object_schema(&["fleetId"], json!({ "fleetId": bounded_string(128) }))
}

fn bounded_string(max_length: usize) -> Value {
    json!({ "type": "string", "minLength": 1, "maxLength": max_length })
}

fn identifier_schema() -> Value {
    json!({
        "type": "string",
        "minLength": 1,
        "maxLength": 128,
        "pattern": "^[A-Za-z0-9_-]+$"
    })
}

fn process_handle_schema() -> Value {
    json!({
        "type": "string",
        "pattern": "^proc-[0-9a-f]{32}$"
    })
}

fn evidence_reference_schema() -> Value {
    json!({
        "type": "string",
        "minLength": 1,
        "maxLength": 128,
        "pattern": "^[A-Za-z0-9_-]+$",
        "description": "Exact ID of already committed task evidence; never a description or placeholder."
    })
}

fn object_schema(required: &[&str], properties: Value) -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": required,
        "properties": properties
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_plan_schema_exposes_durable_identifier_constraints() {
        let tool = default_model_tools()
            .into_iter()
            .find(|tool| tool.name == "update_plan")
            .expect("update_plan tool");
        assert_eq!(tool.input_schema["required"], json!(["steps"]));
        assert!(tool.input_schema["properties"].get("planVersion").is_none());
        assert!(tool
            .description
            .contains("assigns the next version automatically"));
        assert!(tool
            .description
            .contains("mark a step completed as soon as it is done"));
        let step = &tool.input_schema["properties"]["steps"]["items"]["properties"];
        assert_eq!(step["id"]["pattern"], "^[A-Za-z0-9_-]+$");
        assert_eq!(step["evidenceRefs"]["items"]["pattern"], "^[A-Za-z0-9_-]+$");
    }

    #[test]
    fn file_write_guidance_keeps_large_content_out_of_terminal_commands() {
        let tools = default_model_tools();
        let terminal = tools
            .iter()
            .find(|tool| tool.name == "run_terminal_command")
            .expect("terminal tool");
        assert!(terminal.description.contains("8192"));
        assert!(terminal.description.contains("UTF-8 bytes"));
        assert!(terminal.description.contains("Use write_file"));
        assert!(terminal.description.contains("delegation does not bypass"));
        assert!(terminal.description.contains("single-line"));
        assert!(terminal.description.contains("heredocs"));
        assert!(terminal.description.contains("Use probe_http"));
        assert!(terminal.description.contains("processHandle"));
        assert!(terminal.description.contains("always clean up"));
        assert_eq!(
            terminal.input_schema["properties"]["command"]["pattern"],
            "^[^\\u0000-\\u001F\\u007F]*$"
        );
        assert_eq!(
            terminal.input_schema["properties"]["background"]["default"],
            false
        );

        for name in ["write_process_input", "wait_process", "kill_process"] {
            let process_tool = tools
                .iter()
                .find(|tool| tool.name == name)
                .unwrap_or_else(|| panic!("missing {name}"));
            assert_eq!(
                process_tool.input_schema["properties"]["processHandle"]["pattern"],
                "^proc-[0-9a-f]{32}$"
            );
        }

        let write = tools
            .iter()
            .find(|tool| tool.name == "write_file")
            .expect("write tool");
        assert!(write.description.contains("mustNotExist"));
        assert!(write.description.contains("read_file first"));
        assert!(write.description.contains("instead of cat, echo, heredocs"));
        assert_eq!(
            write.input_schema["required"],
            json!(["path", "content", "precondition"])
        );
        assert_eq!(
            write.input_schema["properties"]["content"]["maxLength"],
            crate::agent_runtime::MAX_WRITE_FILE_CONTENT_BYTES
        );
        assert!(write.input_schema["properties"].get("dryRun").is_none());
        assert_eq!(
            write.input_schema["properties"]["precondition"]["oneOf"][0]["properties"]
                ["mustNotExist"]["const"],
            true
        );

        let patch = tools
            .iter()
            .find(|tool| tool.name == "apply_patch")
            .expect("patch tool");
        assert!(patch.description.contains("existing UTF-8 file"));
        assert!(patch.description.contains("Use write_file"));
    }

    #[test]
    fn http_probe_schema_exposes_only_bounded_target_loopback_request_fields() {
        let tool = default_model_tools()
            .into_iter()
            .find(|tool| tool.name == "probe_http")
            .expect("probe_http tool");
        assert!(tool.description.contains("frozen target's 127.0.0.1"));
        assert!(tool.description.contains("authenticated SSH target"));
        assert!(tool.description.contains("redirects are not followed"));
        assert_eq!(
            tool.input_schema["required"],
            json!(["method", "port", "path"])
        );
        assert_eq!(
            tool.input_schema["properties"]["method"]["enum"],
            json!(["get", "head", "post", "put", "patch", "delete"])
        );
        assert!(tool.input_schema["properties"].get("url").is_none());
        assert!(tool.input_schema["properties"].get("headers").is_none());
        assert_eq!(tool.input_schema["properties"]["body"]["maxLength"], 65_536);
    }

    #[test]
    fn interactive_terminal_tools_are_feature_gated() {
        assert!(!default_model_tools()
            .iter()
            .any(|tool| tool.name == "read_terminal"));
        let tools = model_tools_with_terminal_interaction(true);
        for name in ["read_terminal", "write_terminal_input", "wait_terminal"] {
            assert!(tools.iter().any(|tool| tool.name == name));
        }
        for tool in &tools {
            assert_eq!(tool.input_schema["type"], "object", "{}", tool.name);
        }
        let write = tools
            .iter()
            .find(|tool| tool.name == "write_terminal_input")
            .expect("write_terminal_input tool");
        assert_eq!(write.input_schema["required"], json!(["inputKind"]));
        assert_eq!(
            write.input_schema["oneOf"].as_array().map(Vec::len),
            Some(4)
        );
    }
}
