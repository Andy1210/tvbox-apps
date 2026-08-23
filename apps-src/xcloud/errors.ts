// Turning a plugin error code into something a person can read.
//
// Two things make this a helper rather than a `t()` call at each site. The SDK's
// `translate()` returns the KEY when it is missing, and a key is truthy - so the
// `|| t("errors.generic")` written at three call sites could never fire, and the
// television printed `errors.http_500` in warn yellow as the only text on screen.
// And the plugin emits far more codes than a screen has words for: every HTTP
// status, and every code from the token chain.
//
// So: a known code is translated, and anything else falls back - with the code
// kept in the log, where it is worth having.
export function errorText(t: (key: string) => string, code: string | undefined): string {
  const key = "errors." + (code || "generic");
  const text = t(key);
  if (text !== key) return text;
  if (code) console.warn("[xcloud] no wording for error code:", code);
  return t("errors.generic");
}
