use crate::agent::protocol::{HostInspectArgsV1, HostInspectFieldV1};
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FixedHostProbeV1 {
    Os,
    Kernel,
    Architecture,
    Identity,
    Uptime,
    Capabilities,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FixedHostInspectPlanV1 {
    pub(crate) probes: Vec<FixedHostProbeV1>,
}

pub(crate) fn prepare_host_inspect_v1(
    arguments: &HostInspectArgsV1,
) -> Result<FixedHostInspectPlanV1, String> {
    if arguments.include.is_empty() || arguments.include.len() > 6 {
        return Err("host.inspect requires one to six fixed fields.".to_string());
    }
    let mut seen = HashSet::new();
    let mut probes = Vec::with_capacity(arguments.include.len());
    for field in &arguments.include {
        if !seen.insert(*field) {
            return Err("host.inspect fields must be unique.".to_string());
        }
        probes.push(match field {
            HostInspectFieldV1::Os => FixedHostProbeV1::Os,
            HostInspectFieldV1::Kernel => FixedHostProbeV1::Kernel,
            HostInspectFieldV1::Architecture => FixedHostProbeV1::Architecture,
            HostInspectFieldV1::Identity => FixedHostProbeV1::Identity,
            HostInspectFieldV1::Uptime => FixedHostProbeV1::Uptime,
            HostInspectFieldV1::Capabilities => FixedHostProbeV1::Capabilities,
        });
    }
    Ok(FixedHostInspectPlanV1 { probes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_inspect_maps_only_enum_fields_to_fixed_probes() {
        let plan = prepare_host_inspect_v1(&HostInspectArgsV1 {
            include: vec![
                HostInspectFieldV1::Os,
                HostInspectFieldV1::Identity,
                HostInspectFieldV1::Capabilities,
            ],
        })
        .unwrap();
        assert_eq!(
            plan.probes,
            [
                FixedHostProbeV1::Os,
                FixedHostProbeV1::Identity,
                FixedHostProbeV1::Capabilities
            ]
        );
    }

    #[test]
    fn duplicate_fixed_fields_fail_closed() {
        assert!(prepare_host_inspect_v1(&HostInspectArgsV1 {
            include: vec![HostInspectFieldV1::Os, HostInspectFieldV1::Os],
        })
        .is_err());
    }
}
