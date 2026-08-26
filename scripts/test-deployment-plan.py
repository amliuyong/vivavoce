#!/usr/bin/env python3
"""Unit tests for check-deployment-plan.py."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("check-deployment-plan.py")
SPEC = importlib.util.spec_from_file_location("check_deployment_plan", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def task(value: str = "1") -> dict:
    return {
        "Type": "AWS::ECS::TaskDefinition",
        "Properties": {
            "ContainerDefinitions": [
                {
                    "Environment": [
                        {"Name": "AIM_CURSOR_VOICED_GATE", "Value": value}
                    ]
                }
            ]
        },
    }


class DeploymentPlanTests(unittest.TestCase):
    def analyze(
        self,
        current: dict,
        proposed: dict,
        diff: str = "",
        *,
        allow_destructive: bool = False,
        allow_security_changes: bool = False,
    ) -> dict:
        return MODULE.analyze(
            current,
            proposed,
            diff,
            ["AIM_CURSOR_VOICED_GATE"],
            allow_destructive,
            allow_security_changes,
        )

    def test_task_definition_replacement_is_safe(self) -> None:
        current = {"Resources": {"Task": task()}}
        proposed = {"Resources": {"Task": task()}}
        diff = "[~] AWS::ECS::TaskDefinition Service/Task Task replace\n"
        result = self.analyze(current, proposed, diff)
        self.assertTrue(result["safe"])
        self.assertEqual(result["environment_failures"], [])

    def test_resource_removal_is_blocked(self) -> None:
        result = self.analyze(
            {"Resources": {"Bucket": {"Type": "AWS::S3::Bucket"}}},
            {"Resources": {}},
        )
        self.assertFalse(result["safe"])
        self.assertIn("resource removal detected", result["blockers"])

    def test_non_task_replacement_is_blocked(self) -> None:
        result = self.analyze(
            {"Resources": {"Bucket": {"Type": "AWS::S3::Bucket"}}},
            {"Resources": {"Bucket": {"Type": "AWS::S3::Bucket"}}},
            "[~] AWS::S3::Bucket Storage/Bucket Bucket may replace\n",
        )
        self.assertFalse(result["safe"])
        self.assertIn(
            "non-task resource replacement detected", result["blockers"]
        )

    def test_runtime_calibration_drift_is_blocked(self) -> None:
        result = self.analyze(
            {"Resources": {"Task": task("1")}},
            {"Resources": {"Task": task("0")}},
        )
        self.assertFalse(result["safe"])
        self.assertEqual(
            result["environment_failures"],
            ["Task:AIM_CURSOR_VOICED_GATE"],
        )

    def test_security_changes_require_explicit_override(self) -> None:
        current = {"Resources": {}}
        proposed = {"Resources": {}}
        blocked = self.analyze(
            current,
            proposed,
            "IAM Statement Changes\n",
        )
        allowed = self.analyze(
            current,
            proposed,
            "IAM Statement Changes\n",
            allow_security_changes=True,
        )
        self.assertFalse(blocked["safe"])
        self.assertTrue(allowed["safe"])


if __name__ == "__main__":
    unittest.main()
