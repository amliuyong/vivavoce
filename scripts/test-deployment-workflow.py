#!/usr/bin/env python3
"""Regression tests for deployment workflow safety contracts."""

from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class DeploymentWorkflowTests(unittest.TestCase):
    def test_remote_runner_uses_build_then_private_umask(self) -> None:
        runner = (ROOT / "scripts/remote-deploy-runner.sh").read_text(
            encoding="utf-8"
        )
        load_env = runner.index("viva_load_env required")
        plan = runner.index("./scripts/viva plan")
        deploy = runner.index("./scripts/viva deploy")
        verification = runner.index('write_stage "waiting-for-services"')

        build_umask = runner.index("umask 022", load_env, plan)
        private_umask = runner.index("umask 077", deploy, verification)
        self.assertLess(load_env, build_umask)
        self.assertLess(build_umask, plan)
        self.assertLess(deploy, private_umask)
        self.assertLess(private_umask, verification)

    def test_backend_image_normalizes_runtime_permissions(self) -> None:
        dockerfile = (ROOT / "backend/Dockerfile").read_text(encoding="utf-8")
        self.assertIn(
            "RUN chmod -R a+rX /app/app /app/static",
            dockerfile,
        )


if __name__ == "__main__":
    unittest.main()
