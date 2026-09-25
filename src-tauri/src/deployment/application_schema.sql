CREATE TABLE deployment_source_bindings (
    id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    binding_json TEXT NOT NULL
);
CREATE TABLE deployment_applications (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_binding_id TEXT NOT NULL UNIQUE REFERENCES deployment_source_bindings(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);
CREATE TABLE deployment_environments (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES deployment_applications(id),
    name TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    workflow_id TEXT UNIQUE REFERENCES deployment_workflows(id),
    config_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (application_id, name)
);
CREATE TABLE deployment_readiness_reports (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL REFERENCES deployment_environments(id),
    environment_revision INTEGER NOT NULL,
    source_revision INTEGER NOT NULL,
    workflow_revision INTEGER NOT NULL,
    checked_at INTEGER NOT NULL,
    report_json TEXT NOT NULL
);
