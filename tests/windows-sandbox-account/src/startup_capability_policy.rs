//! Shared fixed startup capability boundary for diagnostic LPAC launchers.
//! Network and service capabilities from comparative experiments are excluded.
pub fn permitted(name: &str) -> bool {
    matches!(name, "registryRead" | "lpacInstrumentation")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_launch_rejects_network_service_and_ambient_capabilities() {
        for name in [
            "internetClient",
            "internetClientServer",
            "privateNetworkClientServer",
            "enterpriseAuthentication",
            "lpacIdentityServices",
            "lpacCryptoServices",
            "lpacCom",
            "lpacServicesManagement",
            "registryRead ",
            "RegistryRead",
            "",
        ] {
            assert!(!permitted(name), "unexpected startup capability: {name}");
        }
        assert!(permitted("registryRead"));
        assert!(permitted("lpacInstrumentation"));
    }
}
