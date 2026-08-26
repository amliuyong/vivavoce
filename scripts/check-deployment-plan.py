#!/usr/bin/env python3
"""Fail-closed checks for a synthesized CloudFormation deployment plan."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


TASK_DEFINITION_TYPE = "AWS::ECS::TaskDefinition"
REPLACEMENT_RE = re.compile(
    r"^\[~\]\s+(?P<type>AWS::\S+)\s+.+\s+(?P<logical_id>\S+)"
    r"\s+(?:may\s+)?replace$"
)


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict):
        raise ValueError(f"{path} does not contain a JSON object")
    return value


def container_environment(resource: dict[str, Any]) -> dict[str, str]:
    containers = resource.get("Properties", {}).get("ContainerDefinitions", [])
    if not containers:
        return {}
    result: dict[str, str] = {}
    for item in containers[0].get("Environment", []):
        name = item.get("Name")
        value = item.get("Value")
        if isinstance(name, str) and isinstance(value, (str, int, float, bool)):
            result[name] = str(value)
    return result


def find_resource_by_type(
    template: dict[str, Any], resource_type: str
) -> list[tuple[str, dict[str, Any]]]:
    resources = template.get("Resources", {})
    return [
        (logical_id, resource)
        for logical_id, resource in resources.items()
        if resource.get("Type") == resource_type
    ]


def analyze(
    current: dict[str, Any],
    proposed: dict[str, Any],
    diff_text: str,
    preserve_env_keys: list[str],
    allow_destructive: bool,
    allow_security_changes: bool,
) -> dict[str, Any]:
    current_resources = current.get("Resources", {})
    proposed_resources = proposed.get("Resources", {})

    added = sorted(set(proposed_resources) - set(current_resources))
    removed = sorted(set(current_resources) - set(proposed_resources))
    changed = sorted(
        key
        for key in set(current_resources) & set(proposed_resources)
        if current_resources[key] != proposed_resources[key]
    )
    type_changed = sorted(
        key
        for key in changed
        if current_resources[key].get("Type")
        != proposed_resources[key].get("Type")
    )

    replacements: list[dict[str, str]] = []
    for line in diff_text.splitlines():
        match = REPLACEMENT_RE.match(line.strip())
        if match:
            replacements.append(match.groupdict())
    non_task_replacements = [
        replacement
        for replacement in replacements
        if replacement["type"] != TASK_DEFINITION_TYPE
    ]

    security_changes = {
        "iam": "IAM Statement Changes" in diff_text,
        "security_groups": "Security Group Changes" in diff_text,
    }

    current_tasks = dict(find_resource_by_type(current, TASK_DEFINITION_TYPE))
    proposed_tasks = dict(find_resource_by_type(proposed, TASK_DEFINITION_TYPE))
    preserved_env: dict[str, str] = {}
    env_failures: list[str] = []
    for logical_id in sorted(set(current_tasks) & set(proposed_tasks)):
        current_env = container_environment(current_tasks[logical_id])
        proposed_env = container_environment(proposed_tasks[logical_id])
        for key in preserve_env_keys:
            if key not in current_env:
                continue
            label = f"{logical_id}:{key}"
            if proposed_env.get(key) == current_env[key]:
                preserved_env[label] = "preserved"
            else:
                env_failures.append(label)

    blockers: list[str] = []
    if not allow_destructive:
        if removed:
            blockers.append("resource removal detected")
        if type_changed:
            blockers.append("resource type change detected")
        if non_task_replacements:
            blockers.append("non-task resource replacement detected")
    if not allow_security_changes and any(security_changes.values()):
        blockers.append("IAM or security-group change detected")
    if env_failures:
        blockers.append("protected runtime environment changed")

    return {
        "safe": not blockers,
        "blockers": blockers,
        "resources": {
            "current": len(current_resources),
            "proposed": len(proposed_resources),
            "added": added,
            "removed": removed,
            "changed": changed,
            "type_changed": type_changed,
        },
        "replacements": replacements,
        "non_task_replacements": non_task_replacements,
        "security_changes": security_changes,
        "preserved_environment": preserved_env,
        "environment_failures": env_failures,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--current", required=True, type=Path)
    parser.add_argument("--proposed", required=True, type=Path)
    parser.add_argument("--cdk-diff", required=True, type=Path)
    parser.add_argument("--summary", required=True, type=Path)
    parser.add_argument("--preserve-env-key", action="append", default=[])
    parser.add_argument("--allow-destructive", action="store_true")
    parser.add_argument("--allow-security-changes", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = analyze(
        load_json(args.current),
        load_json(args.proposed),
        args.cdk_diff.read_text(encoding="utf-8"),
        args.preserve_env_key,
        args.allow_destructive,
        args.allow_security_changes,
    )
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    resources = result["resources"]
    print(
        "PLAN:"
        f" current={resources['current']}"
        f" proposed={resources['proposed']}"
        f" added={len(resources['added'])}"
        f" removed={len(resources['removed'])}"
        f" changed={len(resources['changed'])}"
        f" replacements={len(result['replacements'])}"
    )
    print(
        "PLAN:"
        f" iam_changes={str(result['security_changes']['iam']).lower()}"
        f" security_group_changes="
        f"{str(result['security_changes']['security_groups']).lower()}"
    )
    if result["preserved_environment"]:
        print(
            "PLAN: protected_runtime_environment="
            f"{len(result['preserved_environment'])} preserved"
        )
    if result["safe"]:
        print("PLAN: SAFE")
        return 0

    for blocker in result["blockers"]:
        print(f"PLAN BLOCKER: {blocker}", file=sys.stderr)
    for logical_id in resources["removed"]:
        print(f"  REMOVE {logical_id}", file=sys.stderr)
    for logical_id in resources["type_changed"]:
        print(f"  TYPE_CHANGE {logical_id}", file=sys.stderr)
    for replacement in result["non_task_replacements"]:
        print(
            f"  REPLACE {replacement['logical_id']} {replacement['type']}",
            file=sys.stderr,
        )
    for label in result["environment_failures"]:
        print(f"  RUNTIME_ENV_CHANGE {label}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
