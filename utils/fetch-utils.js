async function fetchWithTimeoutAndRetry(url, options = {}) {
  const { timeout = 8000, retries = 1, name = 'request', ...fetchOptions } = options;
  const backoff = (attempt) => Math.min(500 * Math.pow(2, attempt), 5000);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
      clearTimeout(id);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`${name} failed: ${res.status} ${res.statusText} ${text}`);
        err.status = res.status;
        throw err;
      }
      return res;
    } catch (err) {
      clearTimeout(id);
      const isTimeout = err.name === 'AbortError' || err.type === 'aborted' || err.code === 'UND_ERR_CONNECT_TIMEOUT';
      const willRetry = attempt < retries && (isTimeout || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND');

      console.log(`[fetch] ${name} attempt ${attempt + 1}/${retries + 1} failed: ${err.message} ${willRetry ? '(retrying)' : ''}`);
      if (!willRetry) throw err;
      await new Promise(r => setTimeout(r, backoff(attempt)));
    }
  }
}

module.exports = { fetchWithTimeoutAndRetry };
