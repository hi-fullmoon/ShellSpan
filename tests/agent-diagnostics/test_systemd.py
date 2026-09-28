"""Acceptance against real systemd, sshd and journald in an isolated container."""
import base64
import json
import subprocess
import sys
import time
import unittest


def collect(name, arguments, user=None):
    payload = base64.b64encode(json.dumps({"_targetId": "systemd-acceptance", **arguments}).encode()).decode()
    command = [sys.executable, "-I", "/opt/diagnostic_collector.py", name, payload]
    if user:
        command = ["runuser", "-u", user, "--", *command]
    output = subprocess.check_output(command, timeout=15)
    return json.loads(output)


class SystemdDiagnosticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Generate genuine service lifecycle evidence, not synthetic journal messages.
        subprocess.run(["systemctl", "start", "ssh.service"], check=True)
        subprocess.run(["systemctl", "restart", "ssh.service"], check=True)
        subprocess.run(["journalctl", "--sync"], check=True)
        now = int(time.time() * 1000)
        cls.query = {"service": "ssh.service", "sinceUnixMs": now - 600000,
                     "untilUnixMs": now + 1000, "maxEntries": 1}

    def test_exact_service_state_matches_manager(self):
        observed = collect("inspect_service", {"service": "ssh.service"})
        self.assertEqual(observed["status"], "ok", observed)
        properties = observed["data"]["properties"]
        self.assertEqual(properties["ActiveState"], "active")
        expected = subprocess.check_output(["systemctl", "show", "--value", "--property=MainPID", "ssh.service"], text=True).strip()
        self.assertEqual(str(properties["MainPID"]), expected)
        self.assertNotIn("Environment", properties)

    def test_journal_cursor_pages_real_records_without_skips(self):
        expected = subprocess.check_output(["journalctl", "--no-pager", "-o", "json", "--unit=ssh.service",
                    "--since=@{:.3f}".format(self.query["sinceUnixMs"] / 1000),
                    "--until=@{:.3f}".format(self.query["untilUnixMs"] / 1000)], text=True)
        records = [json.loads(line) for line in expected.splitlines() if line]
        self.assertGreater(len(records), 1, "real ssh service lifecycle must have journal evidence")
        actual, cursor = [], None
        for _ in range(len(records) + 1):
            result = collect("query_logs", {**self.query, **({"cursor": cursor} if cursor else {})})
            self.assertEqual(result["status"], "ok", result)
            actual.extend(entry["message"] for entry in result["data"]["entries"])
            cursor = result["data"]["nextCursor"]
            if not cursor:
                break
        self.assertIsNone(cursor, "bounded pagination must reach the end of the fixed window")
        self.assertEqual(actual, [record["MESSAGE"][:2048] for record in records])

    def test_cursor_rejects_changed_query_and_literal_filter_is_not_regex(self):
        page = collect("query_logs", self.query)
        cursor = page["data"]["nextCursor"]
        self.assertIsNotNone(cursor)
        changed = collect("query_logs", {**self.query, "cursor": cursor, "service": "systemd-journald.service"})
        self.assertEqual(changed["code"], "invalidCursor")
        other_target = collect("query_logs", {**self.query, "cursor": cursor, "_targetId": "another-target"})
        self.assertEqual(other_target["code"], "invalidCursor")
        literal = collect("query_logs", {**self.query, "keyword": ".*"})
        self.assertEqual(literal["status"], "ok", literal)
        self.assertEqual(literal["data"]["entries"], [])

    def test_journal_permission_denial_is_not_an_empty_healthy_result(self):
        result = collect("query_logs", self.query, user="nobody")
        self.assertEqual(result["status"], "unavailable", result)
        self.assertEqual(result["code"], "commandFailed")
        self.assertNotIn("data", result)


if __name__ == "__main__":
    unittest.main()
