#!/usr/bin/env bun
/**
 * webhooks-session-store - webhooks session store implementation
 * REST API client wrapper
 */
const API_BASE = process.env.API_BASE || "https://api.example.com";
const API_TOKEN = process.env.API_TOKEN;

class APIClient {
  private token?: string;
  constructor(token?: string) { this.token = token || API_TOKEN; }
  private async request<T>(endpoint: string, opts: RequestInit = {}): Promise<T> {
    const r = await fetch(`${API_BASE}${endpoint}`, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(this.token ? { "Authorization": `Bearer ${this.token}` } : {}), ...opts.headers },
    });
    if (!r.ok) throw new Error(`API error ${r.status}`);
    return r.json();
  }
  async get<T>(ep: string): Promise<T> { return this.request<T>(ep); }
  async post<T>(ep: string, body: any): Promise<T> { return this.request<T>(ep, { method: "POST", body: JSON.stringify(body) }); }
}

if (import.meta.main) {
  const client = new APIClient();
  console.log(`${name} API client ready against ${API_BASE}`);
}
