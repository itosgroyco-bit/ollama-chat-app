export type OllamaMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type OllamaModel = {
  name: string;
  size?: number;
  modified_at?: string;
};

const STORAGE_KEY_URL = "ollama-api-url";
const STORAGE_KEY_MODEL = "ollama-model";

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export function getOllamaUrl(): string {
  return localStorage.getItem(STORAGE_KEY_URL) || DEFAULT_OLLAMA_URL;
}

export function setOllamaUrl(url: string) {
  localStorage.setItem(STORAGE_KEY_URL, url.replace(/\/+$/, ""));
}

export function getSavedModel(): string {
  return localStorage.getItem(STORAGE_KEY_MODEL) || "";
}

export function setSavedModel(model: string) {
  localStorage.setItem(STORAGE_KEY_MODEL, model);
}

async function apiFetch(baseUrl: string, path: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, init);
  if (!res.ok) {
    throw new Error(`Ollama respondió con error ${res.status}`);
  }
  return res;
}

export async function listModels(baseUrl: string): Promise<OllamaModel[]> {
  const res = await apiFetch(baseUrl, "/api/tags");
  const data = (await res.json()) as { models?: OllamaModel[] };
  return data.models ?? [];
}

export async function* streamChat(
  baseUrl: string,
  model: string,
  messages: OllamaMessage[],
  signal?: AbortSignal | null,
): AsyncGenerator<string> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama respondió con error ${res.status}${text ? `: ${text}` : ""}`);
  }
  if (!res.body) throw new Error("La respuesta de Ollama no tiene cuerpo");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const json = JSON.parse(trimmed) as { message?: { content?: string }; done?: boolean };
        const chunk = json.message?.content;
        if (chunk) yield chunk;
      } catch {
        // línea incompleta, se ignora
      }
    }
  }
}
