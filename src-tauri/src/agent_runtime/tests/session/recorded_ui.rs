// Export real replay snapshots for the browser UI checks. No store is opened,
// no ledger is changed, and no provider or terminal operation is executed.
#[test]
#[ignore = "requires explicit read-only ledger/database paths and a new output path"]
fn export_recorded_agent_panel_evidence() {
    use crate::llm::routes::{ModelSelection, RouteSnapshot};
    use rusqlite::{Connection, OpenFlags};
    use std::io::{BufReader, BufWriter, Write};

    let input = |key: &str| std::env::var(key).expect(key);
    let read_events = |key: &str| {
        let file = File::open(input(key)).expect("open recorded ledger read-only");
        serde_json::Deserializer::from_reader(BufReader::new(file))
            .into_iter::<AgentSessionEvent>()
            .collect::<Result<Vec<_>, _>>()
            .expect("decode recorded ledger")
    };
    let events = read_events("SHELLSPAN_UI_REVIEW_LEDGER");
    let failures = read_events("SHELLSPAN_UI_REVIEW_FAILURE_LEDGER");
    let replay = |events: &[AgentSessionEvent]| {
        let record = AgentSessionRecord::from_events(events.to_vec()).expect("replay real events");
        serde_json::json!({
            "snapshot": record.snapshot().expect("derive production snapshot"),
            "events": events,
        })
    };
    let task_end = events
        .iter()
        .position(|event| matches!(event.payload, AgentSessionEventPayload::TaskPlan { .. }))
        .expect("recorded task plan");
    let question_end = events
        .iter()
        .position(|event| {
            matches!(
                event.payload,
                AgentSessionEventPayload::QuestionRequested { .. }
            )
        })
        .expect("recorded question");
    let database = Connection::open_with_flags(
        input("SHELLSPAN_UI_REVIEW_DATABASE"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("open route configuration read-only");
    let document: String = database
        .query_row(
            "SELECT value FROM preferences WHERE key='llm.routes.v1'",
            [],
            |row| row.get(0),
        )
        .expect("read real model routes");
    let routes: RouteSnapshot = serde_json::from_str(&document).expect("decode real model routes");
    let mut models = serde_json::Map::new();
    for route in &routes.routes {
        let resolved = route
            .model_catalog()
            .expect("resolve configured model catalog")
            .keys()
            .map(|model_id| {
                let selection = ModelSelection {
                    route_id: route.id.clone(),
                    model_id: model_id.clone(),
                    reasoning_effort: None,
                };
                let provider = route
                    .provider(&selection)
                    .expect("resolve configured provider");
                crate::llm::catalog::resolve(&provider).expect("resolve configured model")
            })
            .collect::<Vec<_>>();
        models.insert(route.id.clone(), serde_json::to_value(resolved).unwrap());
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let output = options
        .open(input("SHELLSPAN_UI_REVIEW_OUTPUT"))
        .expect("create new private review evidence file");
    let mut writer = BufWriter::new(output);
    serde_json::to_writer(
        &mut writer,
        &serde_json::json!({
            "tasks": replay(&events[..=task_end]),
            "question": replay(&events[..=question_end]),
            "settled": replay(&events),
            "failure": replay(&failures),
            "routes": routes,
            "modelsByRoute": models,
        }),
    )
    .expect("write review evidence");
    writer.flush().expect("flush review evidence");
}
