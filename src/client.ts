export async function apiRequest(path: string, body?: unknown, method?: string): Promise<any> {
  const token = process.env.API_TOKEN;
  if (!token) throw new Error('API_TOKEN is required');
  const url = (process.env.API_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
  const response = await fetch(`${url}${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(600000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Family Brief API: HTTP ${response.status}. ${data.error || ''}`);
  return data;
}
