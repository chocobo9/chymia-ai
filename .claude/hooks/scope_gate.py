#!/usr/bin/env python3
"""Stop-hook backstop, v2 — structural, not vocabulary.

Rule: if THIS turn modified files (Edit/Write/MultiEdit/NotebookEdit), the final
assistant message MUST contain a well-formed SCOPE-DELTA block (header + at least
one DONE/PARTIAL/SKIPPED marker). Otherwise -> block (exit 2).

Why structural: "does the block exist" is binary and cannot be laundered. v1
greped magnitude words + digits; that was a word arms race and failed 4/4
adversarial cases. This does not look at vocabulary at all.

Conversational turns (no file edits) are never blocked — the gate only applies
where scope reduction can hide, i.e. when code was actually written.

Exit 2 = block (stderr -> Claude). Exit 0 = allow.
Fail-VISIBLE: if the transcript can't be parsed (schema/path), the hook does NOT
silently pass — it logs a diagnostic to scope_gate.log next to this script and
exits 0 (never jams the session). Check that log if the gate seems inactive.
"""
import json
import os
import re
import sys
import time

CODE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
SCOPE_DELTA_HEADER = re.compile(r"SCOPE[-\s]?DELTA", re.IGNORECASE)
MARKER = re.compile(r"\b(DONE|PARTIAL|SKIPPED)\b")
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scope_gate.log")


def diag(msg):
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except OSError:
        pass


def read_entries(path):
    entries = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def text_of(entry):
    """Concatenated text blocks of an assistant entry (content may be str or list)."""
    content = entry.get("message", {}).get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def tool_names(entry):
    content = entry.get("message", {}).get("content", "")
    if not isinstance(content, list):
        return []
    return [
        b.get("name", "")
        for b in content
        if isinstance(b, dict) and b.get("type") == "tool_use"
    ]


def analyze(entries):
    """Return (wrote_code, last_assistant_text) for the current turn.

    Current turn = entries after the last 'user' entry. Returns (None, None) if
    no assistant entry is found at all (treated as schema mismatch by caller).
    """
    last_user = -1
    for i, e in enumerate(entries):
        if e.get("type") == "user":
            last_user = i
    turn = entries[last_user + 1:] if last_user >= 0 else entries

    saw_assistant = False
    wrote_code = False
    last_text = ""
    for e in turn:
        if e.get("type") != "assistant":
            continue
        saw_assistant = True
        if any(n in CODE_TOOLS for n in tool_names(e)):
            wrote_code = True
        t = text_of(e)
        if t:
            last_text = t
    if not saw_assistant:
        return None, None
    return wrote_code, last_text


def main():
    raw = sys.stdin.read()
    try:
        inp = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        inp = {}

    if inp.get("stop_hook_active"):  # loop guard
        sys.exit(0)

    path = inp.get("transcript_path", "")
    if not path or not os.path.exists(path):
        diag(f"WARN transcript not found: {path!r} — gate inactive this turn")
        sys.exit(0)

    try:
        entries = read_entries(path)
    except OSError as ex:
        diag(f"WARN cannot read transcript: {ex} — gate inactive")
        sys.exit(0)

    wrote_code, text = analyze(entries)
    if wrote_code is None:  # no assistant entry => schema mismatch, fail visible
        diag("WARN no assistant entry parsed (schema mismatch?) — gate inactive")
        sys.exit(0)

    if not wrote_code:  # conversational turn — gate does not apply
        sys.exit(0)

    has_header = bool(SCOPE_DELTA_HEADER.search(text))
    has_marker = bool(MARKER.search(text))

    if has_header and has_marker:
        sys.exit(0)

    if not has_header:
        reason = "本轮改动了文件，但收尾没有 SCOPE-DELTA 块。"
    else:
        reason = "SCOPE-DELTA 块存在但没有任何 DONE/PARTIAL/SKIPPED 标记（格式不合）。"

    msg = (
        "SCOPE-GATE 拦截（exit 2）：\n- " + reason +
        "\n\n补一个 SCOPE-DELTA 块，对照本次任务陈述的需求逐条标 "
        "DONE / PARTIAL(差什么+为什么) / SKIPPED(理由)。砍掉的只能以 SKIPPED 出现，"
        "禁止无声省略。"
    )
    print(msg, file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
