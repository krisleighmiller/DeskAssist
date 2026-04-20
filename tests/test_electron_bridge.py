from assistant_app.electron_bridge import _parse_messages, _serialize_message
from assistant_app.models import ChatMessage


def test_electron_bridge_parse_preserves_tool_call_id():
    parsed = _parse_messages(
        [
            {
                "role": "tool",
                "content": '{"ok": true}',
                "tool_call_id": "call_123",
            }
        ]
    )
    assert parsed == [
        ChatMessage(
            role="tool",
            content='{"ok": true}',
            tool_calls=None,
            tool_call_id="call_123",
        )
    ]


def test_electron_bridge_serialize_includes_tool_call_id():
    message = ChatMessage(
        role="tool",
        content='{"ok": true}',
        tool_calls=None,
        tool_call_id="call_abc",
    )
    serialized = _serialize_message(message)
    assert serialized["role"] == "tool"
    assert serialized["tool_call_id"] == "call_abc"
