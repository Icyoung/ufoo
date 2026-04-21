const { REDACTED, redactSecrets, redactString, isSensitiveKey } = require("../../../src/providerapi/redactor");

describe("providerapi redactor", () => {
  test("redacts sensitive keys recursively while preserving structure", () => {
    const input = {
      accessToken: "access-secret",
      nested: {
        refresh_token: "refresh-secret",
        headers: {
          Authorization: "Bearer abc.def.ghi",
        },
      },
      list: [
        { apiKey: "key-1" },
        "Authorization: Bearer xyz-token",
      ],
    };

    expect(redactSecrets(input)).toEqual({
      accessToken: REDACTED,
      nested: {
        refresh_token: REDACTED,
        headers: {
          Authorization: REDACTED,
        },
      },
      list: [
        { apiKey: REDACTED },
        "Authorization: Bearer [REDACTED]",
      ],
    });
  });

  test("redactString masks bearer tokens without destroying surrounding text", () => {
    expect(redactString("call with Authorization: Bearer secret-token now")).toBe(
      "call with Authorization: Bearer [REDACTED] now"
    );
  });

  test("isSensitiveKey recognizes representative secret field names", () => {
    expect(isSensitiveKey("Authorization")).toBe(true);
    expect(isSensitiveKey("access_token")).toBe(true);
    expect(isSensitiveKey("refreshToken")).toBe(true);
    expect(isSensitiveKey("token_hash")).toBe(true);
    expect(isSensitiveKey("token")).toBe(true);
    expect(isSensitiveKey("token_count")).toBe(false);
  });
});
