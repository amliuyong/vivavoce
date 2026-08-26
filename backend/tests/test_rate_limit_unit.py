"""per-client 令牌桶限流单测(design contract)。注入假时钟,不真 sleep。"""
from __future__ import annotations

from app.rate_limit import TokenBucketLimiter


def test_burst_then_throttle():
    """突发 burst 个请求放行,第 burst+1 个拒(同一时刻不回填)。"""
    t = [0.0]
    lim = TokenBucketLimiter(rate=5.0, burst=20, now=lambda: t[0])
    allowed = sum(1 for _ in range(20) if lim.allow("c1"))
    assert allowed == 20
    assert lim.allow("c1") is False  # 第 21 个超 burst


def test_refill_over_time():
    """时间推进 → 按 rate 回填令牌,可再放行。"""
    t = [0.0]
    lim = TokenBucketLimiter(rate=5.0, burst=20, now=lambda: t[0])
    for _ in range(20):
        lim.allow("c1")
    assert lim.allow("c1") is False
    t[0] = 1.0  # 1 秒后回填 5 个(rate=5/s)
    assert sum(1 for _ in range(5) if lim.allow("c1")) == 5
    assert lim.allow("c1") is False  # 第 6 个又超


def test_per_client_isolation():
    """不同 client 各自独立桶,互不影响。"""
    t = [0.0]
    lim = TokenBucketLimiter(rate=5.0, burst=2, now=lambda: t[0])
    assert lim.allow("a") and lim.allow("a")
    assert lim.allow("a") is False  # a 桶空
    assert lim.allow("b") and lim.allow("b")  # b 桶满,不受 a 影响


def test_lru_eviction_bounds_memory():
    """桶数超 max_keys → 驱逐最久未用(review:防 client_id 无界增长 OOM)。"""
    t = [0.0]
    lim = TokenBucketLimiter(rate=5.0, burst=2, now=lambda: t[0], max_keys=3)
    for k in ["a", "b", "c"]:
        lim.allow(k)
    lim.allow("a")  # 触碰 a → a 变最近使用,b 成最久未用
    lim.allow("d")  # 超容量(4>3)→ 驱逐最久未用的 b
    assert "b" not in lim._buckets
    assert set(lim._buckets) == {"a", "c", "d"}


def test_retry_after_estimates_backoff():
    """retry_after:桶空时给出 ≥1 的退避秒数;桶有余量返 0(review)。"""
    t = [0.0]
    lim = TokenBucketLimiter(rate=5.0, burst=2, now=lambda: t[0])
    assert lim.retry_after("fresh") == 1  # 没见过的 key:保守给 1
    lim.allow("c1")
    lim.allow("c1")  # 桶空(burst=2)
    assert lim.retry_after("c1") >= 1  # 需等回填
    lim.allow("c2")  # c2 还剩 1 个令牌
    assert lim.retry_after("c2") == 0  # 仍有余量,无需退避


def test_retry_after_zero_rate():
    """rate=0(不回填)→ retry_after 返 1(不能算出有限等待,给保守值)。"""
    lim = TokenBucketLimiter(rate=0.0, burst=1, now=lambda: 0.0)
    lim.allow("c1")  # 桶空
    assert lim.retry_after("c1") == 1
