/**
 * Tiny client for write-protection. The owner enters a password once;
 * we persist it in localStorage and attach it to every mutating request
 * as the X-Write-Password header. The backend either ignores it (dev
 * mode, no env var set) or 401s if it doesn't match.
 */

const STORAGE_KEY = "myaistro_write_pw";

export function getStoredWritePassword() {
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function setStoredWritePassword(pw) {
  try {
    if (pw) localStorage.setItem(STORAGE_KEY, pw);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* no-op — private mode etc. */
  }
}

export function clearStoredWritePassword() {
  setStoredWritePassword("");
}

/**
 * fetch() wrapper that injects the write-password header on requests.
 * Use for any mutating call. Headers from the caller are preserved.
 */
export function writeFetch(url, options = {}) {
  const pw = getStoredWritePassword();
  const headers = new Headers(options.headers || {});
  if (pw) headers.set("X-Write-Password", pw);
  return fetch(url, { ...options, headers });
}
