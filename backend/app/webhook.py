"""Webhook 投递(design contract)—— HMAC 签名 + 可靠投递(指数退避重试 + 死信)。

事件负载带唯一 event_id + 时间戳(第三方据此去重,因「至少一次」可能重投)。
每次推送带 HMAC-SHA256 签名头(用 client 的 webhook secret 签 body),第三方验签防伪造。
录音不直发文件,负载只给限时预签名拉取链接(守数据主权)。
"""
from __future__ import annotations

import hashlib
import hmac
import json

SIGNATURE_HEADER = "X-AIM-Signature"
EVENT_ID_HEADER = "X-AIM-Event-Id"


def validate_webhook_url(url: str) -> None:
    """校验 webhook URL,防 SSRF(review 高危):必须 https + 不得指向内网/loopback/link-local/云元数据。

    阻断 169.254.169.254(AWS/GCP 元数据,可偷 IAM 凭证)、RFC1918 私网、loopback、link-local。
    非法抛 ValueError(API 层 422)。注:DNS rebinding(域名解析到内网)本函数只挡 IP 字面量与已知元数据域名;
    完整防护需投递时再校验解析后 IP(留增强项)。
    """
    from ipaddress import ip_address
    from urllib.parse import urlparse

    if not url.startswith("https://"):
        raise ValueError("webhook url 必须是 https")
    host = (urlparse(url).hostname or "").lower()
    if not host:
        raise ValueError("webhook url 非法(无主机名)")
    forbidden_hosts = {"169.254.169.254", "metadata.google.internal", "localhost"}
    if host in forbidden_hosts:
        raise ValueError("webhook url 不得指向云元数据/本机地址")
    try:
        addr = ip_address(host)  # host 是 IP 字面量
    except ValueError:
        return  # 域名(非 IP 字面量):放行(DNS rebinding 留投递时增强)
    if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved or addr.is_multicast:
        raise ValueError("webhook url 不得指向内网/loopback/link-local/保留地址")


def _resolved_ips_are_safe(host: str) -> tuple[bool, str]:
    """投递时校验域名**解析后的所有 IP** 不指向内网/元数据(防 DNS rebinding,design contract review)。
    注册时只挡 IP 字面量;攻击者可注册合法域名,稍后把 A 记录改指向 169.254.169.254/内网 → 投递时 SSRF。

    只在**解析出内网/保留 IP** 时拦截。解析失败(NXDOMAIN/网络)**不拦** —— 交给后续 HTTP 连接自然失败
    走正常重试/死信路径(否则把「主机暂时解析不了」误判成 SSRF,且让 deliver 的重试语义失真)。
    返回 (safe, detail)。"""
    import socket
    from ipaddress import ip_address

    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:  # noqa: BLE001 - 解析失败不算 SSRF,放行给 HTTP 层正常失败重试
        return True, ""
    for info in infos:
        ip = info[4][0]
        try:
            addr = ip_address(ip)
        except ValueError:
            continue
        if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved or addr.is_multicast:
            return False, f"解析到内网/保留地址 {ip}(疑似 DNS rebinding)"
    return True, ""

# 订阅事件类型(design contract)
EVENT_SESSION_COMPLETED = "session.completed"
EVENT_SESSION_FAILED = "session.failed"
EVENT_RESULT_READY = "result.ready"
VALID_EVENTS = frozenset({EVENT_SESSION_COMPLETED, EVENT_SESSION_FAILED, EVENT_RESULT_READY})


def sign_payload(body: bytes, secret: str) -> str:
    """对 body 算 HMAC-SHA256,返回 `sha256=<hex>`(GitHub 风格,第三方易实现验签)。"""
    mac = hmac.new(secret.encode("utf-8"), body, hashlib.sha256)
    return f"sha256={mac.hexdigest()}"


def canonical_body(event: dict) -> bytes:
    """确定性序列化(sort_keys + 紧凑分隔符),保证签名两端字节一致。"""
    return json.dumps(event, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode("utf-8")


def build_event(*, event_id: str, event_type: str, ts: str, data: dict) -> dict:
    """组装事件负载。event_id 唯一(去重)、ts 时间戳、type 事件类型、data 业务数据。"""
    return {"event_id": event_id, "type": event_type, "ts": ts, "data": data}


def deliver(url: str, event: dict, secret: str, *, timeout_s: float = 5.0,
            max_attempts: int = 4, sleep=None) -> tuple[bool, int, str]:
    """投递一次事件(含指数退避重试)。返回 (ok, attempts_used, detail)。

    至少一次语义:非 2xx / 超时按指数退避重试 max_attempts 次;全失败返回 ok=False(调用方进死信)。
    sleep 可注入(测试加速/避免真 sleep)。退避 = 0.5 * 2^(n-1) 秒。
    """
    import time as _time

    _sleep = sleep or _time.sleep
    body = canonical_body(event)
    sig = sign_payload(body, secret)
    headers = {
        "Content-Type": "application/json",
        SIGNATURE_HEADER: sig,
        EVENT_ID_HEADER: event["event_id"],
    }
    # 投递前二次校验解析 IP(防 DNS rebinding,design contract review):注册时合法的域名可能已被改指向内网。
    from urllib.parse import urlparse
    host = (urlparse(url).hostname or "").lower()
    safe, detail = _resolved_ips_are_safe(host)
    if not safe:
        return False, 0, f"SSRF 拦截: {detail}"

    last_detail = ""
    for attempt in range(1, max_attempts + 1):
        try:
            import httpx

            resp = httpx.post(url, content=body, headers=headers, timeout=timeout_s)
            if 200 <= resp.status_code < 300:
                return True, attempt, str(resp.status_code)
            last_detail = f"HTTP {resp.status_code}"
        except Exception as exc:  # noqa: BLE001
            last_detail = str(exc)
        if attempt < max_attempts:
            _sleep(0.5 * (2 ** (attempt - 1)))
    return False, max_attempts, last_detail
