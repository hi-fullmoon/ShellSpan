use super::workflow_schema::{
    DeploymentWorkflowDefinition, DeploymentWorkflowLayout, WorkflowNodeLayout,
};
use std::collections::BTreeMap;

pub(crate) fn static_site_template(
    connection_profile_id: &str,
    remote_root: &str,
) -> Result<(DeploymentWorkflowDefinition, DeploymentWorkflowLayout), String> {
    let mut definition: DeploymentWorkflowDefinition = serde_json::from_str(include_str!(
        "../../../protocol/deployment/fixtures/static-site-workflow.json"
    ))
    .map_err(|error| format!("static-site template fixture is invalid: {error}"))?;
    let target = definition
        .targets
        .first_mut()
        .ok_or_else(|| "static-site template target is missing".to_string())?;
    target.connection_profile_id = connection_profile_id.to_string();
    target.remote_root = remote_root.to_string();
    let nodes = definition
        .nodes
        .iter()
        .enumerate()
        .map(|(index, node)| {
            (
                node.id.clone(),
                WorkflowNodeLayout {
                    x: (index as f64) * 240.0,
                    y: 0.0,
                    collapsed: None,
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    Ok((
        definition,
        DeploymentWorkflowLayout {
            schema_version: 1,
            nodes,
            groups: Vec::new(),
            viewport: None,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment::{
        compiler::compile_workflow_definition, node_registry::DeploymentNodeRegistry,
    };

    #[test]
    fn template_factory_binds_only_target_identity_and_remains_compilable() {
        let (definition, layout) =
            static_site_template("profile-template", "/srv/www/template").unwrap();
        assert_eq!(
            definition.targets[0].connection_profile_id,
            "profile-template"
        );
        assert_eq!(definition.targets[0].remote_root, "/srv/www/template");
        assert_eq!(layout.nodes.len(), definition.nodes.len());
        let compiled =
            compile_workflow_definition(&definition, &DeploymentNodeRegistry::mvp()).unwrap();
        assert!(compiled
            .nodes
            .iter()
            .any(|node| node.node_type == "deploy.static-switch"));
    }
}
