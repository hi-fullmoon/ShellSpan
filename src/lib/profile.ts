import type { ConnectionProfile } from "../types";

export function createEmptyProfile(): ConnectionProfile {
  return {
    id: crypto.randomUUID(),
    name: "New Session",
    host: "",
    port: 22,
    username: "",
    authMethod: "password",
    rememberPassword: false,
    password: "",
    privateKeyPath: "",
    passphrase: "",
  };
}

export function sanitizeProfileForStorage(
  profile: ConnectionProfile,
): ConnectionProfile {
  return {
    ...profile,
    password:
      profile.authMethod === "password" && profile.rememberPassword
        ? profile.password ?? ""
        : "",
    passphrase: "",
  };
}

export function describeSession(profile: ConnectionProfile) {
  return profile.name.trim() || `${profile.username}@${profile.host}`;
}
