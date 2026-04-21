import { useEffect, useRef, useState } from "react";
import type {
  ApiKeyStatus,
  ChatMessage,
  ComparisonSession,
  Provider,
} from "../types";

interface ComparisonChatTabProps {
  provider: Provider;
  keyStatus: ApiKeyStatus;
  session: ComparisonSession | null;
  busy: boolean;
  onSend: (text: string) => void;
  onClose: () => void;
}

function describeMessage(msg: ChatMessage): { roleClass: string; text: string } {
  if (msg.role === "tool") {
    return { roleClass: "tool", text: (msg.content ?? "").slice(0, 240) };
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

export function ComparisonChatTab({
  provider,
  keyStatus,
  session,
  busy,
  onSend,
  onClose,
}: ComparisonChatTabProps): JSX.Element {
  const [input, setInput] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);
  // Same elapsed-time ticker as `ChatTab` so comparison chats also surface
  // a visible "agent working" indicator instead of just a disabled Send.
  const [busyStart, setBusyStart] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (busy) {
      setBusyStart((prev) => prev ?? Date.now());
    } else {
      setBusyStart(null);
    }
  }, [busy]);

  useEffect(() => {
    if (busyStart === null) return;
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, [busyStart]);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [session?.messages, busy]);

  if (!session) {
    return (
      <div className="placeholder">
        <p><strong>No comparison chat open.</strong></p>
        <p>
          Open a multi-lane chat from the <em>Lanes</em> tab. Comparison
          chats are <strong>read-only</strong> across all selected lanes plus
          their ancestors, attachments, and casefile context — the model
          cannot modify any file.
        </p>
      </div>
    );
  }

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
  const inputDisabled = busy;
  const laneNames = session.lanes.map((l) => l.name).join(" ↔ ");
  const elapsedSeconds = busyStart === null ? 0 : Math.max(0, Math.floor((now - busyStart) / 1000));
  const elapsedLabel =
    elapsedSeconds < 60
      ? `${elapsedSeconds}s`
      : `${Math.floor(elapsedSeconds / 60)}m${(elapsedSeconds % 60).toString().padStart(2, "0")}s`;

  return (
    <div className="chat">
      <div className="chat-controls" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%" }}>
          <strong style={{ color: "#a78bfa" }}>Compare:</strong>
          <span>{laneNames}</span>
          <button
            type="button"
            className="link-button"
            onClick={onClose}
            style={{ marginLeft: "auto" }}
          >
            close
          </button>
        </div>
        <span style={{ color: "#9ca3af", fontSize: 12 }}>
          Read-only across {session.laneIds.length} lanes; no write tools available.
        </span>
        {keyMissing && (
          <span style={{ color: "#fbbf24" }}>
            No API key configured for {provider}. Open API Keys to add one.
          </span>
        )}
      </div>
      <div className="chat-messages" ref={messagesRef}>
        {session.messages.length === 0 && (
          <div style={{ color: "#6b7280", fontStyle: "italic" }}>
            Ask the model to compare these lanes. It can read every file
            under <code>_lanes/&lt;id&gt;/</code> for each lane.
          </div>
        )}
        {session.messages.map((msg, idx) => {
          const { roleClass, text } = describeMessage(msg);
          return (
            <div className={`msg ${roleClass}`} key={idx}>
              <span className="role">{msg.role}</span>
              {text}
            </div>
          );
        })}
        {busy && (
          <div className="msg assistant chat-working" role="status" aria-live="polite">
            <span className="role">agent</span>
            <span className="chat-working-spinner" aria-hidden="true" />
            <span className="chat-working-text">
              Thinking...
              <span className="chat-working-elapsed"> · {elapsedLabel}</span>
            </span>
          </div>
        )}
      </div>
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
          placeholder="Ask about the differences between these lanes..."
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
