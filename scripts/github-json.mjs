// Retry transient GitHub failures without exposing response bodies or credentials.
export async function githubJson(url, init, {
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 4,
  timeoutMs = 30000,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let result;
    let failure;
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const retryable = response.status === 429 || response.status >= 500 ||
        (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
      if (retryable) {
        failure = new Error(`GitHub returned HTTP ${response.status}`);
      } else if (!response.ok) {
        return { response, body: null };
      } else {
        try {
          result = { response, body: await response.json() };
        } catch {
          failure = new Error(`GitHub returned invalid JSON (HTTP ${response.status})`);
        }
      }
    } catch {
      failure = new Error('GitHub request failed or timed out');
    }
    if (result) return result;
    if (attempt + 1 === attempts) throw failure;
    await sleep(3000 * (attempt + 1));
  }
}
