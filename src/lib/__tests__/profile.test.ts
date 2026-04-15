import { describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../../types";
import {
  createEmptyProfile,
  describeSession,
  sanitizeProfileForStorage,
} from "../profile";

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

  it("keeps the password only when password auth is remembered", () => {
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
      password: "secret",
      passphrase: "",
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
