"""应用层 per-client 限流(design contract)—— 进程内令牌桶。

定位:CloudFront 前置 WAF 已做粗粒度(IP/总量)限速;这里补**按 API client 的细粒度**限流,
防单个集成方刷爆控制面/GPU 配额(per-client 公平性)。

实现:每 client_id 一个令牌桶(容量 burst,按 rate/秒匀速回填)。超限抛 429。
★ 进程内状态(非分布式)的局限,如实标注:控制面 Fargate `BACKEND_MIN_TASKS=1` 起步,但 CPU 高时
  autoscale 到 `BACKEND_MAX_TASKS=4`。多 task 下每 task 各持一份桶 → 同一 client 的请求被 ALB 分散到
  N 个 task 时,**有效限速 ≈ 配置值 × task 数**(限得更松,不会更严,也不会误杀)。这是"温和降级"而非失效:
  CloudFront WAF 仍兜粗粒度总量;真·分布式 per-client 限流需 DDB/Redis 共享计数(design contract 标 v1)。
  无外部依赖、O(1)。

★ 线程安全(review):require_api_client 是 sync `def` 依赖,FastAPI 把它派发到 anyio 线程池
  → 同 client 的并发请求落在不同线程,裸字典访问会丢更新(两线程各读 tokens=1 都放行只扣 1)。
  故 allow()/retry_after() 全程持 threading.Lock(O(1) 临界区,不成瓶颈)。

时钟经 now() 注入便于单测(不真 sleep)。
"""
from __future__ import annotations

import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from math import ceil


@dataclass
class _Bucket:
    tokens: float
    last_refill: float


@dataclass
class TokenBucketLimiter:
    """per-key 令牌桶。rate=每秒回填令牌数,burst=桶容量(允许的突发)。

    线程安全(review):require_api_client 是同步依赖,FastAPI 在 anyio threadpool 跑 →
    同 key 的并发请求会进多个线程。allow() 全程持锁(O(1) 路径,不成瓶颈),否则两条并发各读
    tokens=1 都放行只扣 1 个 → 越限放行。
    桶字典有上界(review):超 MAX_KEYS 时按最久未用(OrderedDict)驱逐,防 client_id 无界增长 OOM。
    """

    rate: float = 5.0  # 稳态 5 req/s/client
    burst: int = 20  # 突发上限 20
    now: Callable[[], float] = time.monotonic
    max_keys: int = 10000  # 桶上界(LRU 驱逐)
    _buckets: OrderedDict[str, _Bucket] = field(default_factory=OrderedDict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def allow(self, key: str, cost: float = 1.0) -> bool:
        """取 cost 个令牌;够则放行(True),不够则拒(False)。线程安全。"""
        with self._lock:
            t = self.now()
            b = self._buckets.get(key)
            if b is None:
                b = _Bucket(tokens=float(self.burst), last_refill=t)
                self._buckets[key] = b
                # LRU 上界:超容量驱逐最久未访问(防无界增长)
                if len(self._buckets) > self.max_keys:
                    self._buckets.popitem(last=False)
            else:
                self._buckets.move_to_end(key)  # 标记最近使用
            # 匀速回填(不超过 burst)
            elapsed = max(0.0, t - b.last_refill)
            b.tokens = min(float(self.burst), b.tokens + elapsed * self.rate)
            b.last_refill = t
            if b.tokens >= cost:
                b.tokens -= cost
                return True
            return False

    def retry_after(self, key: str, cost: float = 1.0) -> int:
        """估算还需多少秒才能再放行 cost 个令牌(review:供 429 的 Retry-After 头)。无桶/rate=0 → 1。"""
        with self._lock:
            b = self._buckets.get(key)
            if b is None or self.rate <= 0:
                return 1
            deficit = cost - b.tokens
            if deficit <= 0:
                return 0
            return max(1, ceil(deficit / self.rate))
