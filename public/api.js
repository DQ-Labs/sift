// Thin wrapper around the local Sift HTTP API.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function readError(response) {
  try {
    const value = await response.json();
    return value?.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

// GET when `data` is undefined, otherwise POST it as JSON.
export async function api(route, data) {
  const options = data === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  };
  const response = await fetch(`/api/${route}`, options);
  if (!response.ok) throw new ApiError(await readError(response), response.status);
  return response.json();
}

// Uploads a rendered stem for a handoff batch.
export async function putWav(route, bytes) {
  const response = await fetch(`/api/${route}`, { method: 'PUT', headers: { 'Content-Type': 'audio/wav' }, body: bytes });
  if (!response.ok) throw new ApiError(await readError(response), response.status);
}

// HEAD request that reports whether an optional endpoint exists.
export async function endpointExists(route) {
  try {
    const response = await fetch(`/api/${route}`, { method: 'HEAD' });
    return response.status !== 404;
  } catch {
    return false;
  }
}

function filenameFrom(response, fallback) {
  const header = response.headers.get('Content-Disposition') || '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return match ? decodeURIComponent(match[1]) : fallback;
}

// Fetches a file from the API and returns it with its suggested filename.
export async function fetchDownload(route, fallbackName) {
  const response = await fetch(`/api/${route}`);
  if (!response.ok) throw new ApiError(await readError(response), response.status);
  return { blob: await response.blob(), name: filenameFrom(response, fallbackName) };
}
