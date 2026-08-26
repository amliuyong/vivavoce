"""测试基建:本地 RSA 签 JWT + seed JWKS + moto DynamoDB。

关键点:测试**不绕过**鉴权逻辑 —— 用本地 RSA 私钥签出和 Cognito 同构的 access token,
把对应公钥 seed 进 JwksCache,于是 CognitoVerifier 走的是与生产**完全一致**的验签/校验路径。
这样 e2e 才真正覆盖"带认证"这条安全红线,而不是 mock 掉它。
"""
from __future__ import annotations

import os
import time

# moto 测试隔离:在 import boto3 前设假凭证 + region,避免受本机 ~/.aws/config / profile 影响,
# 也防止误连真实 AWS。必须早于 boto3/botocore 初始化。
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")
os.environ.setdefault("AWS_SECURITY_TOKEN", "testing")
os.environ.setdefault("AWS_SESSION_TOKEN", "testing")
os.environ.pop("AWS_PROFILE", None)  # 不让外部 profile 干扰 moto

import boto3  # noqa: E402
import pytest  # noqa: E402
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jose import jwt
from jose.utils import long_to_base64
from moto import mock_aws

from app.auth import CognitoVerifier, JwksCache
from app.config import Settings
from app.db import Db
from app.main import create_app

REGION = "us-east-1"
USER_POOL_ID = "us-east-1_TESTPOOL"
CLIENT_ID = "testclient0123456789"
KID = "testkey-1"


def _make_settings(
    ddb_endpoint: str | None = None,
    *,
    role_claim: str = "cognito:groups",  # design contract:角色来源 claim 名(默认现状)
    role_map: dict[str, str] | None = None,  # design contract:值映射(默认恒等)
) -> Settings:
    return Settings(
        region=REGION,
        user_pool_id=USER_POOL_ID,
        user_pool_client_id=CLIENT_ID,
        agents_table="aim-agents",
        question_banks_table="aim-question-banks",
        targets_table="aim-targets",
        sessions_table="aim-sessions",
        results_table="aim-results",
        session_events_table="aim-session-events",
        slot_pools_table="aim-slot-pools",
        integration_table="aim-integration",
        system_config_table="aim-system-config",
        recording_bucket="aim-recordings",
        default_engine_type="three_stage",
        dynamodb_endpoint_url=ddb_endpoint,
        auth_mode="local",
        max_concurrency=8,
        gpu_capacity_static_fallback=8,
        staff_edit_lock_min=30,
        session_join_expire_min=30,
        bridge_dial_url=None,
        candidate_token_secret="test-candidate-secret-0123456789",
        delegation_token_secret="test-delegation-secret-0123456789",
        # design contract:metadata 的 resource / challenge URL 依赖它(本特性下必填,CDK 已注入 CloudFront 域)。
        public_api_base="https://test.cloudfront.net",
        bridge_callback_secret="test-bridge-callback-secret-0123456789",
        minimax_secret_arn=None,
        gpu_control_url=None,
        gpu_control_secret=None,
        llm_secret_arn=None,
        mcp_client_id="mcpclient0123456789",  # design contract:MCP OAuth code-flow client
        cognito_hosted_ui_domain="aim-aimtest-12345678",  # design contract:Hosted UI 域前缀
        mcp_facade_state_secret="test-facade-state-secret-0123456789",  # design contract:HMAC state 密钥
        role_claim=role_claim,  # design contract
        role_map=role_map,  # design contract
        realtime_client_secret="test-realtime-client-secret-0123456789",
    )


@pytest.fixture(scope="session")
def rsa_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="session")
def jwks(rsa_key) -> dict:
    """从私钥导出 JWKS 公钥(RS256),与 Cognito JWKS 同构。"""
    pub = rsa_key.public_key().public_numbers()
    return {
        "keys": [
            {
                "kty": "RSA",
                "kid": KID,
                "use": "sig",
                "alg": "RS256",
                "n": long_to_base64(pub.n).decode("ascii"),
                "e": long_to_base64(pub.e).decode("ascii"),
            }
        ]
    }


@pytest.fixture
def make_token(rsa_key):
    """签一个 Cognito 风格的 access token。"""
    pem = rsa_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )

    def _make(
        *,
        groups: list[str] | None = None,
        token_use: str = "access",
        client_id: str = CLIENT_ID,
        issuer: str | None = None,
        expired: bool = False,
        username: str = "alice@corp.com",
        kid: str = KID,
        scope: str | None = None,  # design contract:MCP OAuth token 的 scope claim(空格分隔)
        extra_claims: dict | None = None,  # design contract:注入任意 claim(替代角色 claim / falsy 值等测试)
    ) -> str:
        now = int(time.time())
        claims = {
            "sub": "sub-" + username,
            "username": username,
            "token_use": token_use,
            "client_id": client_id,
            "iss": issuer or f"https://cognito-idp.{REGION}.amazonaws.com/{USER_POOL_ID}",
            "iat": now,
            "exp": now - 60 if expired else now + 3600,
        }
        if groups is not None:
            claims["cognito:groups"] = groups
        if scope is not None:
            claims["scope"] = scope
        if extra_claims:
            claims.update(extra_claims)  # design contract:可覆盖/新增任意 claim(含替代角色 claim)
        return jwt.encode(claims, pem, algorithm="RS256", headers={"kid": kid})

    return _make


@pytest.fixture
def app_and_db(jwks):
    """装配 app + moto DynamoDB + 建表 + seed JWKS。"""
    with mock_aws():
        settings = _make_settings()
        # 建表 —— 主键/GSI **必须与 CDK dynamodb-tables.ts 完全一致**(否则 schema 漂移会掩盖生产 bug)。
        ddb = boto3.resource("dynamodb", region_name=REGION)
        # Agents(design contract,原 KnowledgeProfiles):PK=agent_id
        ddb.create_table(
            TableName=settings.agents_table,
            KeySchema=[{"AttributeName": "agent_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "agent_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        # QuestionBanks(design contract):PK=question_bank_id
        ddb.create_table(
            TableName=settings.question_banks_table,
            KeySchema=[{"AttributeName": "question_bank_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "question_bank_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        # Sessions:PK=session_id + 三个 GSI(对齐 CDK,锁住 created_at 稀疏索引漂移 review)
        # (CampaignIndex 已随 Campaign 删除;infra 侧表仍在,代码访问层不再依赖该 GSI)
        ddb.create_table(
            TableName=settings.sessions_table,
            KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}],
            AttributeDefinitions=[
                {"AttributeName": "session_id", "AttributeType": "S"},
                {"AttributeName": "trigger", "AttributeType": "S"},
                {"AttributeName": "booked_by", "AttributeType": "S"},
                {"AttributeName": "created_at", "AttributeType": "S"},
                {"AttributeName": "status", "AttributeType": "S"},
            ],
            GlobalSecondaryIndexes=[
                *(
                    {
                        "IndexName": idx,
                        "KeySchema": [
                            {"AttributeName": pk, "KeyType": "HASH"},
                            {"AttributeName": "created_at", "KeyType": "RANGE"},
                        ],
                        "Projection": {"ProjectionType": "ALL"},
                    }
                    for idx, pk in [
                        ("TriggerIndex", "trigger"),
                        ("BookedByIndex", "booked_by"),
                    ]
                ),
                # StatusIndex(design contract):reconciler 按 status query 预扩 P / 积压 Q,避免全表 scan。
                # partition-only(无 sort key):无 meeting_start 的会话也须入索引。
                {
                    "IndexName": "StatusIndex",
                    "KeySchema": [{"AttributeName": "status", "KeyType": "HASH"}],
                    "Projection": {"ProjectionType": "ALL"},
                },
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        # Targets:PK=target_id,GSI ExternalIdIndex 按 external_id(对齐 CDK)
        ddb.create_table(
            TableName=settings.targets_table,
            KeySchema=[{"AttributeName": "target_id", "KeyType": "HASH"}],
            AttributeDefinitions=[
                {"AttributeName": "target_id", "AttributeType": "S"},
                {"AttributeName": "external_id", "AttributeType": "S"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": "ExternalIdIndex",
                    "KeySchema": [{"AttributeName": "external_id", "KeyType": "HASH"}],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        # Results:PK=session_id(与 Session 1:1,对齐 CDK)
        ddb.create_table(
            TableName=settings.results_table,
            KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        # SessionEvents:PK=session_id, SK=sk(meta|event#<ts>,对齐 CDK)
        ddb.create_table(
            TableName=settings.session_events_table,
            KeySchema=[
                {"AttributeName": "session_id", "KeyType": "HASH"},
                {"AttributeName": "sk", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "session_id", "AttributeType": "S"},
                {"AttributeName": "sk", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )

        # SlotPools:PK=slot_id + GSI EngagementIndex(engagement_id, meeting_start)(对齐 CDK,design contract)
        ddb.create_table(
            TableName=settings.slot_pools_table,
            KeySchema=[{"AttributeName": "slot_id", "KeyType": "HASH"}],
            AttributeDefinitions=[
                {"AttributeName": "slot_id", "AttributeType": "S"},
                {"AttributeName": "engagement_id", "AttributeType": "S"},
                {"AttributeName": "meeting_start", "AttributeType": "S"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": "EngagementIndex",
                    "KeySchema": [
                        {"AttributeName": "engagement_id", "KeyType": "HASH"},
                        {"AttributeName": "meeting_start", "KeyType": "RANGE"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
            BillingMode="PAY_PER_REQUEST",
        )

        # Integration:PK=pk, SK=sk(API client / Webhook / 幂等键,design contract,对齐 CDK)
        ddb.create_table(
            TableName=settings.integration_table,
            KeySchema=[
                {"AttributeName": "pk", "KeyType": "HASH"},
                {"AttributeName": "sk", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "pk", "AttributeType": "S"},
                {"AttributeName": "sk", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )

        # SystemConfig:PK=config_key(design contract:gpu_capacity_config / gpu_capacity_live 两条记录)
        ddb.create_table(
            TableName=settings.system_config_table,
            KeySchema=[{"AttributeName": "config_key", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "config_key", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )

        app = create_app(settings)
        # 覆盖 db 用 moto resource;verifier seed 本地 JWKS
        app.state.db = Db(settings, resource=ddb)
        verifier = CognitoVerifier(settings, jwks=JwksCache(settings.jwks_url))
        verifier.jwks.seed(jwks["keys"])
        app.state.verifier = verifier
        yield app, app.state.db


@pytest.fixture
def client(app_and_db):
    from fastapi.testclient import TestClient

    app, _ = app_and_db
    return TestClient(app)
