import { describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../../types";
import {
  createEmptyProfile,
  describeSession,
  parseQuickConnect,
  sanitizeProfileForStorage,
} from '../profile';

describe("createEmptyProfile", () => {
  it("creates a profile with the default connection settings", () => {
    const generatedId =
      "00000000-0000-4000-8000-000000000000" as `${string}-${string}-${string}-${string}-${string}`;
    vi.spyOn(crypto, "randomUUID").mockReturnValue(generatedId);

    expect(createEmptyProfile()).toEqual({
      id: generatedId,
      name: "New Session",
      host: "",
      port: 22,
      username: "",
      authMethod: "password",
      pinned: false,
      favorite: false,
      rememberPassword: false,
      password: "",
      privateKeyPath: "",
      passphrase: "",
      bookmarks: [],
    });
  });
});

describe("sanitizeProfileForStorage", () => {
  const baseProfile: ConnectionProfile = {
    id: "profile-1",
    name: "Demo",
    host: "example.com",
    port: 22,
    username: "root",
    authMethod: "password",
  };

  it("always clears the password (stored in OS keychain)", () => {
    expect(
      sanitizeProfileForStorage({
        ...baseProfile,
        rememberPassword: true,
        password: "secret",
        passphrase: "ignored",
      }),
    ).toEqual({
      ...baseProfile,
      pinned: false,
      favorite: false,
      rememberPassword: true,
      password: "",
      passphrase: "",
      bookmarks: [],
      color: undefined,
      jumpHost: undefined,
    });
  });

  it("clears secrets for key auth and unremembered passwords", () => {
    expect(
      sanitizeProfileForStorage({
        ...baseProfile,
        authMethod: "key",
        rememberPassword: true,
        password: "secret",
        passphrase: "key-passphrase",
        pinned: true,
        favorite: true,
      }),
    ).toEqual({
      ...baseProfile,
      authMethod: "key",
      rememberPassword: true,
      password: "",
      passphrase: "",
      pinned: true,
      favorite: true,
      bookmarks: [],
      color: undefined,
      jumpHost: undefined,
    });
  });
});

describe("describeSession", () => {
  it("prefers a trimmed custom name", () => {
    expect(
      describeSession({
        id: "profile-1",
        name: "  Production SSH  ",
        host: "example.com",
        port: 22,
        username: "root",
        authMethod: "password",
      }),
    ).toBe("Production SSH");
  });

  it("falls back to username and host when the name is blank", () => {
    expect(
      describeSession({
        id: "profile-1",
        name: "   ",
        host: "example.com",
        port: 22,
        username: "root",
        authMethod: "password",
      }),
    ).toBe("root@example.com");
  });
});

describe("parseQuickConnect", () => {
  it("parses user@host:port", () => {
    expect(parseQuickConnect("root@192.168.1.1:2222")).toEqual({
      username: "root",
      host: "192.168.1.1",
      port: 2222,
    });
  });

  it("parses user@host", () => {
    expect(parseQuickConnect("deploy@example.com")).toEqual({
      username: "deploy",
      host: "example.com",
    });
  });

  it("parses host:port", () => {
    expect(parseQuickConnect("server.local:2222")).toEqual({
      host: "server.local",
      port: 2222,
    });
  });

  it("parses host only", () => {
    expect(parseQuickConnect("192.168.1.1")).toEqual({
      host: "192.168.1.1",
    });
  });

  it("returns undefined for empty input", () => {
    expect(parseQuickConnect("")).toBeUndefined();
  });

  it("returns undefined for invalid input", () => {
    expect(parseQuickConnect("not valid")).toBeUndefined();
  });

  it("returns undefined for out-of-range port", () => {
    expect(parseQuickConnect("host:99999")).toBeUndefined();
  });

  it("returns undefined for port 0", () => {
    expect(parseQuickConnect("host:0")).toBeUndefined();
  });

  it("returns undefined for port 65536", () => {
    expect(parseQuickConnect("host:65536")).toBeUndefined();
  });

  it("trims leading and trailing whitespace", () => {
    expect(parseQuickConnect("  user@host:2222  ")).toEqual({
      username: "user",
      host: "host",
      port: 2222,
    });
  });
});
