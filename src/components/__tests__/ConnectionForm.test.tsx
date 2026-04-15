// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "../../types";
import { ConnectionForm } from "../ConnectionForm";

const baseProfile: ConnectionProfile = {
  id: "profile-1",
  name: "Demo",
  host: "example.com",
  port: 22,
  username: "root",
  authMethod: "password",
  rememberPassword: false,
  password: "secret",
  privateKeyPath: "",
  passphrase: "",
};

describe("ConnectionForm", () => {
  afterEach(() => {
    cleanup();
  });

  it("propagates text and number field updates", () => {
    const onProfileChange = vi.fn();

    render(
      <ConnectionForm
        onConnect={vi.fn()}
        onProfileChange={onProfileChange}
        profile={baseProfile}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("Demo"), {
      target: { value: "Production" },
    });
    fireEvent.change(screen.getByDisplayValue("22"), {
      target: { value: "2222" },
    });

    expect(onProfileChange).toHaveBeenNthCalledWith(1, {
      ...baseProfile,
      name: "Production",
    });
    expect(onProfileChange).toHaveBeenNthCalledWith(2, {
      ...baseProfile,
      port: 2222,
    });
  });

  it("switches to key auth and clears password fields", () => {
    const onProfileChange = vi.fn();

    render(
      <ConnectionForm
        onConnect={vi.fn()}
        onProfileChange={onProfileChange}
        profile={{ ...baseProfile, rememberPassword: true }}
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "key" },
    });

    expect(onProfileChange).toHaveBeenCalledWith({
      ...baseProfile,
      authMethod: "key",
      rememberPassword: false,
      password: "",
      privateKeyPath: "",
      passphrase: "",
    });
  });

  it("submits the profile together with remember flags", () => {
    const onConnect = vi.fn();

    render(
      <ConnectionForm
        onConnect={onConnect}
        onProfileChange={vi.fn()}
        profile={{ ...baseProfile, rememberPassword: true }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "启动连接" }));

    expect(onConnect).toHaveBeenCalledWith(
      { ...baseProfile, rememberPassword: true },
      true,
      true,
    );
  });
});
