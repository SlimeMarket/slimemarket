#!/usr/bin/env python3
"""
otp-fetch.py — read a Circle / SlimeMarket OTP straight out of the Spacemail
mailbox (IMAP) so local e2e tests can complete the real email-OTP flow.

Why IMAP and not SMTP: the repo only ships SMTP (send-only, nodemailer). The
`rimuru@slimemarket.app` mailbox is a catch-all, so mail addressed to ANY
`*@slimemarket.app` lands in that one inbox. We log into that single mailbox
over IMAP and pull the newest message addressed to the recipient we asked for.

Usage
-----
  # newest OTP for a catch-all recipient (waits up to 120s for it to arrive)
  python scripts/tools/otp-fetch.py --to testseller@slimemarket.app

  # dump raw subjects to debug (shows the 10 newest messages)
  python scripts/tools/otp-fetch.py --list

  # self-test: prove the IMAP credentials work at all
  python scripts/tools/otp-fetch.py --whoami

Env (read from .env.local, then the process environment):
  SMTP_HOST   mail.spacemail.com   (IMAP host is derived: imap.spacemail.com;
                                    the SMTP username/password are reused)
  SMTP_USER   rimuru@slimemarket.app
  SMTP_PASS   <spacemail password>

Exit codes: 0 = OTP printed, 1 = not found / error, 2 = config/credentials bad.
"""

from __future__ import annotations

import argparse
import email
import email.policy
import imaplib
import os
import re
import ssl
import sys
import time
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime
from datetime import timezone
from pathlib import Path
from typing import Iterable, Optional

REPO = Path(__file__).resolve().parents[2]

# Spacemail serves IMAP on the same credentials as SMTP.
DEFAULT_SMTP_HOST = "mail.spacemail.com"
# Spacemail serves IMAP on the SAME hostname as SMTP (mail.spacemail.com,
# port 993). There is no `imap.spacemail.com` record — verified 2026-09-27.
IMAP_HOST = "mail.spacemail.com"
IMAP_PORT = 993

# Circle's OTP is a 6-digit code. Match a standalone run of 4-8 digits that is
# not part of a longer number (avoids swallowing order ids, amounts, dates).
OTP_RE = re.compile(r"(?<!\d)(\d{4,8})(?!\d)")
# Words that usually introduce the code in Circle's template.
OTP_CONTEXT_RE = re.compile(
    r"(?:code|otp|verification|verify|pin|kode|verifikasi)\s*[:\-]?\s*(\d{4,8})",
    re.IGNORECASE,
)


def load_env_local() -> dict[str, str]:
    """Minimal .env.local parser — no dotenv dependency for a test helper."""
    env: dict[str, str] = {}
    path = REPO / ".env.local"
    if not path.exists():
        return env
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        # Strip a single layer of matching quotes.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        env[key] = value
    return env


def resolve_config() -> tuple[str, int, str, str]:
    env = load_env_local()
    imap_host = os.environ.get("IMAP_HOST") or env.get("IMAP_HOST") or IMAP_HOST
    imap_port = int(os.environ.get("IMAP_PORT") or env.get("IMAP_PORT") or IMAP_PORT)
    user = (os.environ.get("SMTP_USER") or env.get("SMTP_USER") or "").strip()
    password = os.environ.get("SMTP_PASS") or env.get("SMTP_PASS") or ""
    if not user or not password:
        print("ERROR: SMTP_USER / SMTP_PASS missing (checked .env.local and env).", file=sys.stderr)
        sys.exit(2)
    return imap_host, imap_port, user, password


def connect(host: str, port: int, user: str, password: str) -> imaplib.IMAP4_SSL:
    ctx = ssl.create_default_context()
    try:
        conn = imaplib.IMAP4_SSL(host, port, ssl_context=ctx)
    except Exception as exc:  # noqa: BLE001 — surfaced to the operator
        print(f"ERROR: cannot open IMAP TLS socket to {host}:{port} — {exc}", file=sys.stderr)
        sys.exit(2)
    try:
        conn.login(user, password)
    except imaplib.IMAP4.error as exc:
        print(f"ERROR: IMAP LOGIN failed for {user} — {exc}", file=sys.stderr)
        print("       Spacemail may have IMAP disabled, or a separate password is required.", file=sys.stderr)
        sys.exit(2)
    return conn


def decode(value: Optional[str]) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:  # noqa: BLE001 — headers in the wild are messy
        return value


def body_text(msg: email.message.Message) -> str:
    """Collect text/plain + text/html bodies into one searchable string."""
    chunks: list[str] = []
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_maintype() == "multipart":
                continue
            ctype = part.get_content_type()
            if ctype not in ("text/plain", "text/html"):
                continue
            try:
                payload = part.get_content()
            except Exception:  # noqa: BLE001
                payload = part.get_payload(decode=True) or b""
                if isinstance(payload, bytes):
                    payload = payload.decode("utf-8", errors="replace")
            chunks.append(str(payload))
    else:
        try:
            chunks.append(str(msg.get_content()))
        except Exception:  # noqa: BLE001
            chunks.append(str(msg.get_payload(decode=True) or ""))
    text = "\n".join(chunks)
    # Strip tags so "<b>1</b><b>2</b>" style spacing does not hide the code.
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"&nbsp;?", " ", text)
    return text


def extract_otp(text: str) -> Optional[str]:
    hit = OTP_CONTEXT_RE.search(text)
    if hit:
        return hit.group(1)
    # Fallback: the OTP is usually the only standalone number in the mail.
    nums = OTP_RE.findall(text)
    if not nums:
        return None
    return max(nums, key=len)


def iter_recent(conn: imaplib.IMAP4_SSL, mailbox: str, limit: int) -> Iterable[email.message.Message]:
    typ, _ = conn.select(mailbox, readonly=True)
    if typ != "OK":
        return
    typ, data = conn.search(None, "ALL")
    if typ != "OK" or not data or not data[0]:
        return
    uids = data[0].split()
    for uid in reversed(uids[-limit:]):
        typ, raw = conn.fetch(uid, "(RFC822)")
        if typ != "OK" or not raw:
            continue
        for item in raw:
            if isinstance(item, tuple) and len(item) >= 2:
                yield email.message_from_bytes(item[1], policy=email.policy.default)


def cmd_list(conn: imaplib.IMAP4_SSL, mailbox: str, limit: int) -> int:
    rows = []
    for msg in iter_recent(conn, mailbox, limit):
        rows.append(
            (
                decode(msg.get("Date")),
                decode(msg.get("From")),
                decode(msg.get("To")),
                decode(msg.get("Subject")),
            )
        )
    if not rows:
        print(f"(mailbox {mailbox!r} has no messages)")
        return 1
    for date, frm, to, subj in rows:
        print(f"{date}\n  FROM {frm}\n  TO   {to}\n  SUBJ {subj}\n")
    return 0


def cmd_whoami(conn: imaplib.IMAP4_SSL) -> int:
    typ, boxes = conn.list()
    print(f"IMAP LOGIN OK — {typ}")
    if typ == "OK":
        for box in boxes or []:
            print("  ", decode(box if isinstance(box, str) else box.decode("utf-8", "replace")))
    return 0


def msg_epoch(msg: email.message.Message) -> float:
    """Message Date as an epoch float; NaN when unparseable."""
    raw = msg.get("Date")
    if not raw:
        return float("nan")
    try:
        dt = parsedate_to_datetime(str(raw))
    except Exception:  # noqa: BLE001 — malformed Date headers happen
        return float("nan")
    if dt is None:
        return float("nan")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def cmd_fetch(
    conn: imaplib.IMAP4_SSL,
    mailbox: str,
    to_addr: str,
    timeout: float,
    interval: float,
    scan: int,
    since: float = 0.0,
) -> int:
    target = to_addr.strip().lower()
    deadline = time.monotonic() + timeout
    attempt = 0
    saw_stale_only = False
    # Circle puts the code in the SUBJECT ("... {AB1-123456} is your login code
    # ...") and often omits it from the body, so search subject + body together.
    while True:
        attempt += 1
        matches = []
        for msg in iter_recent(conn, mailbox, scan):
            to_hdr = decode(msg.get("To")).lower()
            cc_hdr = decode(msg.get("Cc")).lower()
            if target and target not in to_hdr and target not in cc_hdr:
                continue
            # `since` (epoch seconds) rejects STALE mail from earlier runs: a
            # catch-all inbox accumulates OTPs and an old code is bound to an
            # already-superseded otpToken, so Circle would reject it. 5s of
            # clock skew is tolerated.
            if since > 0:
                sent = msg_epoch(msg)
                if sent == sent and sent < since - 5:  # NaN-safe comparison
                    saw_stale_only = True
                    continue
            matches.append(msg)

        for msg in matches:
            subject = decode(msg.get("Subject"))
            text = f"{subject}\n{body_text(msg)}"
            otp = extract_otp(text)
            if otp:
                print(otp)
                print(
                    f"# source: {subject!r} from {decode(msg.get('From'))} "
                    f"at {decode(msg.get('Date'))}",
                    file=sys.stderr,
                )
                return 0

        if time.monotonic() >= deadline:
            note = (
                " — only STALE mail matched (all older than --since)"
                if saw_stale_only and not matches
                else ""
            )
            print(
                f"ERROR: no OTP found for {to_addr} after {timeout:.0f}s "
                f"({len(matches)} matching message(s), {attempt} attempt(s)){note}",
                file=sys.stderr,
            )
            return 1
        time.sleep(interval)
        # Keep the connection healthy across a long poll.
        try:
            conn.noop()
        except Exception:  # noqa: BLE001
            conn = None  # caller cannot recover here; fall through to next sleep


def main() -> int:
    ap = argparse.ArgumentParser(description="Fetch SlimeMarket/Circle OTP over IMAP (Spacemail).")
    ap.add_argument("--to", help="recipient address to match (catch-all e.g. testseller@slimemarket.app)")
    ap.add_argument("--mailbox", default="INBOX", help="IMAP mailbox (default INBOX)")
    ap.add_argument(
        "--since",
        type=float,
        default=0.0,
        help="epoch seconds; ignore OTP mail older than this (rejects stale catch-all mail)",
    )
    ap.add_argument("--timeout", type=float, default=120.0, help="seconds to wait for the mail")
    ap.add_argument("--interval", type=float, default=5.0, help="poll interval in seconds")
    ap.add_argument("--scan", type=int, default=25, help="how many newest messages to scan")
    ap.add_argument("--list", action="store_true", help="list newest messages instead of fetching an OTP")
    ap.add_argument("--whoami", action="store_true", help="verify credentials + list mailboxes")
    args = ap.parse_args()

    host, port, user, password = resolve_config()
    conn = connect(host, port, user, password)

    try:
        if args.whoami:
            return cmd_whoami(conn)
        if args.list:
            return cmd_list(conn, args.mailbox, args.scan)
        if not args.to:
            print("ERROR: --to is required (or use --list / --whoami)", file=sys.stderr)
            return 2
        return cmd_fetch(
            conn, args.mailbox, args.to, args.timeout, args.interval, args.scan, args.since
        )
    finally:
        try:
            conn.logout()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    sys.exit(main())
