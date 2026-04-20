import { useEffect, useRef, useState } from "react";
import type { ApiKeyStatus, ChatMessage, Provider, ToolCall } from "../types";

interface ChatTabProps {
  provider: Provider;
  keyStatus: ApiKeyStatus;
  messages: ChatMessage[];
  pendingApprovals: ToolCall[];
  busy: boolean;
  hasActiveLane: boolean;
  /**
   * M4.1: name of the system prompt currently injected into this lane's
   * chat (or null if none). Shown as a small badge in the controls strip.
   */
  activePromptName: string | null;
  onClearActivePrompt: () => void;
  onSend: (text: string) => void;
  onApproveTools: () => void;
  onDenyTools: () => void;
}

function compactToolResult(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      const cmd = typeof parsed.cmd === "string" ? parsed.cmd : "tool";
      const status = parsed.ok ? "ok" : "error";
      const summary = typeof parsed.summary === "string" ? parsed.summary : "";
      return `${cmd} (${status})${summary ? ` - ${summary}` : ""}`;
    }
  } catch {
    // not JSON; fall through
  }
  return content.length > 240 ? `${content.slice(0, 240)}...` : content;
}

function describeMessage(msg: ChatMessage): { roleClass: string; text: string } {
  if (msg.role === "tool") {
    return { roleClass: "tool", text: compactToolResult(msg.content ?? "") };
  }
  if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    const names = msg.tool_calls.map((c) => c.name).join(", ");
    const text = msg.content && msg.content.length > 0
      ? `${msg.content}\n\n[requested tools: ${names}]`
      : `[requested tools: ${names}]`;
    return { roleClass: "tool", text };
  }
  if (msg.role === "user") {
    return { roleClass: "user", text: msg.content || "[empty]" };
  }
  return { roleClass: "assistant", text: msg.content || "[empty]" };
}

function providerHasKey(provider: Provider, status: ApiKeyStatus): boolean {
  if (provider === "openai") return status.openaiConfigured;
  if (provider === "anthropic") return status.anthropicConfigured;
  return status.deepseekConfigured;
}

export function ChatTab({
  provider,
  keyStatus,
  messages,
  pendingApprovals,
  busy,
  hasActiveLane,
  activePromptName,
  onClearActivePrompt,
  onSend,
  onApproveTools,
  onDenyTools,
}: ChatTabProps): JSX.Element {
  const [input, setInput] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages, pendingApprovals]);

  const submit = () => {
    const value = input.trim();
    if (!value) return;
    onSend(value);
    setInput("");
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const keyMissing = !providerHasKey(provider, keyStatus);
  const inputDisabled = busy || !hasActiveLane;

  return (
    <div className="chat">
      <div className="chat-controls">
        {!hasActiveLane ? (
          <span style={{ color: "#fbbf24" }}>
            Open a casefile and select a lane to start a chat.
          </span>
        ) : keyMissing ? (
          <span style={{ color: "#fbbf24" }}>
            No API key configured for {provider}. Open API Keys to add one.
          </span>
        ) : (
          <span style={{ color: "#9ca3af" }}>Provider: {provider}</span>
        )}
        {activePromptName && (
          <span className="chat-prompt-badge" title="System prompt injected this turn">
            Prompt: {activePromptName}
            <button
              type="button"
              className="chat-prompt-clear"
              onClick={onClearActivePrompt}
              disabled={busy}
              title="Clear system prompt"
            >
              ×
            </button>
          </span>
        )}
      </div>
      <div className="chat-messages" ref={messagesRef}>
        {messages.length === 0 && (
          <div style={{ color: "#6b7280", fontStyle: "italic" }}>
            {hasActiveLane
              ? "No messages yet for this lane. Ask about your workspace."
              : "No active lane."}
          </div>
        )}
        {messages.map((msg, idx) => {
          const { roleClass, text } = describeMessage(msg);
          return (
            <div className={`msg ${roleClass}`} key={idx}>
              <span className="role">{msg.role}</span>
              {text}
            </div>
          );
        })}
      </div>
      {pendingApprovals.length > 0 && (
        <div className="approval-panel">
          <div className="summary">
            {`Approval required for write tools:\n` +
              pendingApprovals
                .map((call) => {
                  const input =
                    call && typeof call.input === "object"
                      ? JSON.stringify(call.input)
                      : "{}";
                  const compactInput = input.length > 240 ? `${input.slice(0, 240)}...` : input;
                  return `- ${call.name}: ${compactInput}`;
                })
                .join("\n")}
          </div>
          <div className="approval-actions">
            <button type="button" onClick={onApproveTools} disabled={busy}>
              Approve and Continue
            </button>
            <button type="button" onClick={onDenyTools} disabled={busy}>
              Deny
            </button>
          </div>
        </div>
      )}
      <form
        className="chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            hasActiveLane ? "Ask about your workspace..." : "Open a casefile to enable chat..."
          }
          disabled={inputDisabled}
        />
        <div className="row">
          <button type="submit" disabled={inputDisabled || !input.trim()}>
            {busy ? "Sending..." : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}
