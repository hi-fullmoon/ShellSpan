import { describe, expect, it } from "vitest";
import { addPathWrapOpportunities } from "../pathDisplay";

describe("addPathWrapOpportunities", () => {
  it("adds wrap opportunities after forward slashes", () => {
    expect(addPathWrapOpportunities("/var/log/nginx")).toBe(
      "/\u200bvar/\u200blog/\u200bnginx",
    );
  });

  it("adds wrap opportunities after backslashes", () => {
    expect(addPathWrapOpportunities(String.raw`C:\Users\demo`)).toBe(
      "C:\\\u200bUsers\\\u200bdemo",
    );
  });

  it("leaves strings without separators unchanged", () => {
    expect(addPathWrapOpportunities("filename.txt")).toBe("filename.txt");
  });
});
