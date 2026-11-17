"""Stateless TLS IMAP/SMTP adapter. The parent process owns the durable cursor."""

import base64
import contextlib
import email
import email.policy
import email.utils
import imaplib
import json
import re
import smtplib
import ssl
import sys
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

MAX_MESSAGE = 12_000_000
MAX_FILES = 3
MAX_FILE = 4_000_000
HEADER = '(UID INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID)])'
ID = re.compile(r'<[^<>\s]{1,240}@[^<>\s]{1,240}>')


def message_id(value):
    found = ID.fullmatch(value or '')
    return found[0] if found else ''


def part_text(part):
    try:
        return str(part.get_content())
    except (AttributeError, KeyError, LookupError, ValueError):
        return ''


def content(raw):
    parsed = email.message_from_bytes(raw, policy=email.policy.default)
    plain = parsed.get_body(preferencelist=('plain',))
    parts = list(parsed.iter_attachments()) if parsed.is_multipart() else ([parsed] if parsed.get_content_disposition() == 'attachment' else [])
    text = part_text(plain) if plain and plain not in parts else ''
    if len(text) > 100000:
        return text[:12000], [], '邮件正文过长，请在邮箱查看原邮件。'
    if len(parts) > MAX_FILES:
        return text, [], '邮件附件超过 3 个，请向学生索取合并版本。'
    files = []
    for index, part in enumerate(parts, 1):
        payload = part.get_payload(decode=True)
        if not payload and part.get_content_type() == 'message/rfc822':
            payload = part.as_bytes()
        if not payload or len(payload) > MAX_FILE:
            return text, [], '附件为空、格式无法读取，或单个附件超过 4 MB。'
        name = (part.get_filename() or f'附件-{index}').replace('\\', '/').split('/')[-1]
        name = ''.join(char for char in name if char.isprintable()).strip()[:200] or f'附件-{index}'
        files.append({'name': name, 'content': base64.b64encode(payload).decode('ascii')})
    issue = None if text or files else '邮件只有 HTML 正文或内容为空，请查看原邮件。'
    return text, files, issue


def open_inbox(stack, cfg):
    client = stack.enter_context(imaplib.IMAP4_SSL(cfg['imapHost'], cfg['imapPort'],
                                                  ssl_context=ssl.create_default_context(), timeout=16))
    client.login(cfg['address'], cfg['password'])
    if client.select('"' + cfg['folder'] + '"', readonly=True)[0] != 'OK':
        raise ValueError('inbox unavailable')
    return client


def open_smtp(stack, cfg):
    context = ssl.create_default_context()
    if cfg['smtpMode'] == 'tls':
        client = stack.enter_context(smtplib.SMTP_SSL(cfg['smtpHost'], cfg['smtpPort'], context=context, timeout=16))
    else:
        client = stack.enter_context(smtplib.SMTP(cfg['smtpHost'], cfg['smtpPort'], timeout=16))
        client.ehlo()
        client.starttls(context=context)
        client.ehlo()
    client.login(cfg['address'], cfg['password'])
    return client


def fetch(client, cfg, cursor):
    validity = int(client.response('UIDVALIDITY')[1][0])
    last = cursor.get('last', 0) if cursor.get('validity') == validity else 0
    since = datetime.fromtimestamp(cfg['since'] / 1000, timezone.utc) - timedelta(days=1)
    months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split()
    date = f'{since.day:02d}-{months[since.month - 1]}-{since.year}'
    status, found = client.uid('SEARCH', None, 'UID', f'{last + 1}:*', 'SINCE', date)
    if status != 'OK' or not found or found[0] is None:
        raise ValueError('UID search failed')
    uids = sorted(uid for value in found[0].split() if (uid := int(value)) > last)[:25]
    if not uids:
        return {'cursor': {'validity': validity, 'last': last}, 'messages': []}
    status, result = client.uid('FETCH', ','.join(map(str, uids)), HEADER)
    if status != 'OK':
        raise ValueError('header fetch failed')
    headers = {}
    for item in result:
        if isinstance(item, tuple):
            uid = int(re.search(rb'\bUID (\d+)', item[0])[1])
            headers[uid] = item
    messages = []
    for uid in uids:
        item = headers.get(uid)
        if not item:
            last = uid  # Message was removed between SEARCH and FETCH.
            continue
        info, raw = item
        when = email.utils.parsedate_to_datetime(re.search(rb'INTERNALDATE "([^"]+)"', info)[1].decode())
        received_at = int(when.timestamp() * 1000)
        parsed = email.message_from_bytes(raw, policy=email.policy.default)
        subject = str(parsed.get('Subject', '')).strip()
        last = uid
        if received_at < cfg['since'] or not subject.casefold().startswith(cfg['prefix'].casefold()):
            continue
        sender = parsed.get('From')
        addresses = sender.addresses if sender and not sender.defects else ()
        address = addresses[0].addr_spec if len(addresses) == 1 else ''
        size = int(re.search(rb'RFC822\.SIZE (\d+)', info)[1])
        text, files, issue = '', [], '邮件原件超过 12 MB，请在邮箱查看。'
        if size <= MAX_MESSAGE:
            status, body = client.uid('FETCH', str(uid), '(BODY.PEEK[])')
            source = next((part[1] for part in body if isinstance(part, tuple)), None)
            if status != 'OK' or source is None:
                raise ValueError('body fetch failed')
            if len(source) <= MAX_MESSAGE:
                text, files, issue = content(source)
        messages.append({
            'uid': uid, 'receivedAt': received_at, 'messageId': message_id(str(parsed.get('Message-ID', ''))),
            'from': address, 'subject': subject[:500], 'text': text, 'files': files,
            'issue': issue or (None if address else '无法确认唯一发件地址。'),
        })
        break  # Keep a single bounded MIME payload per helper process.
    return {'cursor': {'validity': validity, 'last': last}, 'messages': messages}


def main(request):
    cfg, operation = request['credentials'], request['operation']
    with contextlib.ExitStack() as stack:
        if operation == 'check':
            open_inbox(stack, cfg)
            open_smtp(stack, cfg)
            return {'ok': True}
        if operation == 'fetch':
            return fetch(open_inbox(stack, cfg), cfg, request['cursor'])
        if operation != 'reply':
            raise ValueError('unexpected operation')
        data = request['message']
        msg = EmailMessage()
        msg['From'], msg['To'] = cfg['address'], data['to']
        msg['Subject'] = 'Re: ' + ' '.join(data['subject'].splitlines()).removeprefix('Re: ')
        msg['Date'] = email.utils.formatdate(localtime=False)
        msg['Message-ID'] = data['id']
        if parent := message_id(data['parent']):
            msg['In-Reply-To'] = msg['References'] = parent
        msg.set_content(data['text'])
        client = open_smtp(stack, cfg)
        client.send_message(msg, from_addr=cfg['address'], to_addrs=[data['to']])
        # Once SMTP has acknowledged DATA, a failed QUIT cannot invalidate delivery.
        stack.pop_all()
        client.close()
        return {'ok': True}


if __name__ == '__main__':
    try:
        # Read bytes and decode UTF-8 explicitly: -I ignores PYTHONUTF8, and a
        # GBK/CP936 locale would otherwise mangle non-ASCII folder/prefix values.
        request = json.loads(sys.stdin.buffer.read().decode('utf-8'))
        response = {'data': main(request)}
    except (imaplib.IMAP4.error, smtplib.SMTPAuthenticationError):
        response = {'error': '邮箱拒绝登录或访问文件夹，请核对完整邮箱地址、客户端专用密码和文件夹。'}
    except ssl.SSLError:
        response = {'error': '邮箱 TLS 验证失败，请核对域名、加密方式和端口。'}
    except (LookupError, ValueError, TypeError, OSError, smtplib.SMTPException):
        response = {'error': '邮箱操作未完成，请核对服务器网络、端口、邮箱协议和账号权限。'}
    print(json.dumps(response, ensure_ascii=True))
