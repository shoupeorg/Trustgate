// Reads a site API response as JSON. When the answer is not JSON (a Cloudflare error page such as
// 1102, a 404 page, a proxy page) the caller gets one clear sentence instead of a raw parse error.
export class NotJsonError extends Error {}

export async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const code = text.match(/error code:?\s*(\d{3,4})/i)?.[1];
    throw new NotJsonError(`The site answered with an error page instead of data (HTTP ${res.status}${code ? ` · Cloudflare error ${code}` : ""}) · please try again in a minute`);
  }
}
