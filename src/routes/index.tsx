import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  DEFAULT_OLLAMA_URL,
  getOllamaUrl,
  getSavedModel,
  listModels,
  setOllamaUrl,
  setSavedModel,
  streamChat,
  type OllamaMessage,
  type OllamaModel,
} from "@/lib/ollama";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Chat Ollama — Asistente de IA local" },
      {
        name: "description",
        content:
          "Interfaz de chat estilo ChatGPT conectada a tu servidor Ollama por API. Configura la URL, elige tu modelo y conversa.",
      },
      { property: "og:title", content: "Chat Ollama — Asistente de IA local" },
      {
        property: "og:description",
        content: "Interfaz de chat estilo ChatGPT conectada a tu servidor Ollama por API.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ChatPage,
});

type Message = OllamaMessage & { id: string };
type Conversation = { id: string; title: string; messages: Message[] };

const CONVERSATIONS_KEY = "ollama-conversations";

function loadConversations(): Conversation[] {
  try {
    return JSON.parse(localStorage.getItem(CONVERSATIONS_KEY) || "[]") as Conversation[];
  } catch {
    return [];
  }
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function ChatPage() {
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [activeId, setActiveId] = useState<string>(() => loadConversations()[0]?.id ?? "");
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [apiUrl, setApiUrl] = useState(getOllamaUrl);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState(getOllamaUrl());

  const [models, setModels] = useState<OllamaModel[]>([]);
  const [model, setModel] = useState(getSavedModel());
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [sidebarOpen, setSidebarOpen] = useState(true);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const active = conversations.find((c) => c.id === activeId);

  // Persistencia de conversaciones
  useEffect(() => {
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
  }, [conversations]);

  // Cargar modelos disponibles desde Ollama
  const refreshModels = useCallback(async () => {
    setModelsError(null);
    try {
      const list = await listModels(getOllamaUrl());
      setModels(list);
      const first = list[0];
      if (first && !list.some((m) => m.name === getSavedModel())) {
        setModel(first.name);
        setSavedModel(first.name);
      }
    } catch {
      setModels([]);
      setModelsError("No se pudo conectar con Ollama. Revisa la URL de la API en Configuración.");
    }
  }, []);

  useEffect(() => {
    refreshModels();
  }, [refreshModels]);

  // Autoscroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages.length, active?.messages.at(-1)?.content]);

  const newChat = () => {
    abortRef.current?.abort();
    setIsStreaming(false);
    setActiveId("");
    setError(null);
    textareaRef.current?.focus();
  };

  const deleteConversation = (id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === activeId) setActiveId("");
  };

  const saveSettings = () => {
    const clean = urlDraft.trim().replace(/\/+$/, "") || DEFAULT_OLLAMA_URL;
    setOllamaUrl(clean);
    setApiUrl(clean);
    setSettingsOpen(false);
    refreshModels();
  };

  const stopStreaming = () => {
    abortRef.current?.abort();
    setIsStreaming(false);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    if (!model) {
      setError("Selecciona un modelo primero (o revisa la conexión con Ollama).");
      return;
    }

    setError(null);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const userMsg: Message = { id: uid(), role: "user", content: text };
    const assistantMsg: Message = { id: uid(), role: "assistant", content: "" };

    let convId = activeId;
    if (!convId) {
      convId = uid();
      const title = text.length > 40 ? text.slice(0, 40) + "…" : text;
      setConversations((prev) => [
        { id: convId!, title, messages: [userMsg, assistantMsg] },
        ...prev,
      ]);
      setActiveId(convId);
    } else {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId ? { ...c, messages: [...c.messages, userMsg, assistantMsg] } : c,
        ),
      );
    }

    setIsStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const history: OllamaMessage[] = [
      ...(conversations.find((c) => c.id === convId)?.messages ?? []),
      userMsg,
    ].map(({ role, content }) => ({ role, content }));

    try {
      for await (const chunk of streamChat(getOllamaUrl(), model, history, controller.signal)) {
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === assistantMsg.id ? { ...m, content: m.content + chunk } : m,
                  ),
                }
              : c,
          ),
        );
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(
          "Error al comunicarse con Ollama: " +
            (e as Error).message +
            ". Verifica la URL de la API en Configuración.",
        );
        // eliminar el mensaje vacío del asistente
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? { ...c, messages: c.messages.filter((m) => m.id !== assistantMsg.id || m.content) }
              : c,
          ),
        );
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* ===== Sidebar ===== */}
      <aside
        className={`flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-all ${
          sidebarOpen ? "w-64" : "w-0 overflow-hidden border-r-0"
        }`}
      >
        <div className="p-3">
          <button
            onClick={newChat}
            className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm font-medium transition-colors hover:bg-sidebar-accent"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Nuevo chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-3">
          <p className="px-2 pb-2 pt-1 text-xs font-medium text-muted-foreground">Historial</p>
          <div className="grid gap-1">
            {conversations.length === 0 && (
              <p className="px-2 text-xs text-muted-foreground">Aún no hay conversaciones.</p>
            )}
            {conversations.map((c) => (
              <div
                key={c.id}
                className={`group flex items-center rounded-lg text-sm ${
                  c.id === activeId ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"
                }`}
              >
                <button
                  onClick={() => setActiveId(c.id)}
                  className="flex-1 truncate px-3 py-2 text-left"
                  title={c.title}
                >
                  {c.title}
                </button>
                <button
                  onClick={() => deleteConversation(c.id)}
                  className="mr-1 hidden rounded p-1 text-muted-foreground hover:text-destructive group-hover:block"
                  title="Eliminar"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M8 6V4h8v2m1 0v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-sidebar-border p-3">
          <button
            onClick={() => {
              setUrlDraft(apiUrl);
              setSettingsOpen(true);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Configuración de la API
          </button>
        </div>
      </aside>

      {/* ===== Área principal ===== */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="rounded-lg p-2 transition-colors hover:bg-accent"
            title="Mostrar/ocultar historial"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" />
            </svg>
          </button>

          <div className="flex items-center gap-2">
            <label className="text-sm text-muted-foreground">Modelo:</label>
            <select
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setSavedModel(e.target.value);
              }}
              className="rounded-lg border border-input bg-secondary px-2 py-1.5 text-sm outline-none focus:border-ring"
            >
              {models.length === 0 && <option value="">Sin conexión…</option>}
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
            <button
              onClick={refreshModels}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="Recargar modelos"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
              </svg>
            </button>
          </div>

          <span className="ml-auto hidden max-w-[280px] truncate text-xs text-muted-foreground" title={apiUrl}>
            {apiUrl}
          </span>
        </header>

        {/* Mensajes */}
        <div className="flex-1 overflow-y-auto">
          {(!active || active.messages.length === 0) && (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-4 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-secondary">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <h1 className="text-2xl font-semibold">¿En qué puedo ayudarte?</h1>
              <p className="max-w-md text-sm text-muted-foreground">
                Escribe un mensaje abajo para conversar con tu modelo de Ollama.
                {modelsError && (
                  <>
                    <br />
                    <span className="text-destructive">{modelsError}</span>
                  </>
                )}
              </p>
            </div>
          )}

          {active && active.messages.length > 0 && (
            <div className="mx-auto max-w-3xl px-4 py-6">
              <div className="grid gap-6">
                {active.messages.map((m) => (
                  <div key={m.id} className={`flex gap-3 ${m.role === "user" ? "justify-end" : ""}`}>
                    {m.role === "assistant" && (
                      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold">
                        AI
                      </div>
                    )}
                    <div
                      className={
                        m.role === "user"
                          ? "max-w-[80%] rounded-2xl bg-secondary px-4 py-2.5"
                          : "min-w-0 flex-1"
                      }
                    >
                      {m.role === "user" ? (
                        <p className="whitespace-pre-wrap text-[0.95rem] leading-relaxed">{m.content}</p>
                      ) : m.content ? (
                        <div className="chat-markdown">
                          <ReactMarkdown>{m.content}</ReactMarkdown>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 py-2">
                          <span className="typing-dot h-2 w-2 rounded-full bg-muted-foreground" />
                          <span className="typing-dot h-2 w-2 rounded-full bg-muted-foreground" />
                          <span className="typing-dot h-2 w-2 rounded-full bg-muted-foreground" />
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div ref={bottomRef} className="h-4" />
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mx-auto w-full max-w-3xl px-4 pb-2">
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
              {error}
            </div>
          </div>
        )}

        {/* Input */}
        <div className="mx-auto w-full max-w-3xl px-4 pb-5 pt-2">
          <div className="flex items-end gap-2 rounded-2xl border border-input bg-secondary p-2.5 shadow-lg focus-within:border-ring">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autoResize();
              }}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Escribe tu mensaje…  (Enter para enviar, Shift+Enter para salto de línea)"
              className="max-h-[200px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[0.95rem] outline-none placeholder:text-muted-foreground"
            />
            {isStreaming ? (
              <button
                onClick={stopStreaming}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-opacity hover:opacity-90"
                title="Detener"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!input.trim()}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                title="Enviar"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
          <p className="pt-2 text-center text-xs text-muted-foreground">
            Conectado a Ollama en {apiUrl} — los modelos pueden cometer errores.
          </p>
        </div>
      </main>

      {/* ===== Modal de configuración ===== */}
      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-border bg-popover p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold">Configuración de la API</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Aquí va el link de tu API de Ollama. Por defecto es{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{DEFAULT_OLLAMA_URL}</code>{" "}
              (Ollama corriendo en tu PC). Si está en otro servidor, pon su URL, por ejemplo{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">http://192.168.1.50:11434</code>.
            </p>

            <label className="mt-4 block text-sm font-medium">URL de la API de Ollama</label>
            <input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveSettings()}
              placeholder={DEFAULT_OLLAMA_URL}
              className="mt-1.5 w-full rounded-lg border border-input bg-secondary px-3 py-2.5 text-sm outline-none focus:border-ring"
              autoFocus
            />

            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Nota: si el navegador bloquea la conexión por CORS, inicia Ollama con la variable de
              entorno <code className="rounded bg-muted px-1 py-0.5">OLLAMA_ORIGINS=*</code> para
              permitir peticiones desde esta página.
            </p>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setSettingsOpen(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm transition-colors hover:bg-accent"
              >
                Cancelar
              </button>
              <button
                onClick={saveSettings}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                Guardar y conectar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
